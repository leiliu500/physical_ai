import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRemoteJWKSet,
  EncryptJWT,
  jwtDecrypt,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { PlatformConfig } from './config.js';
import { HttpError, type Principal, type Role } from './contracts.js';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
const random = (): string => randomBytes(32).toString('base64url');
const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function cookie(req: IncomingMessage, name: string): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + '='))
    ?.slice(name.length + 1);
}
const roles: Role[] = ['viewer', 'operator', 'supervisor', 'admin'];

export class Authentication {
  private discovery?: Promise<Discovery>;
  private jwks?: JWTVerifyGetKey;
  constructor(
    private config: PlatformConfig,
    private injectedKey?: JWTVerifyGetKey,
  ) {
    if (injectedKey && config.environment !== 'test')
      throw new Error('Signing key injection is restricted to automated tests.');
  }
  private async metadata(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const response = await fetch(
        this.config.issuer!.replace(/\/$/, '') + '/.well-known/openid-configuration',
        { signal: AbortSignal.timeout(5000), redirect: 'error' },
      );
      if (!response.ok) throw new Error('Identity provider discovery failed.');
      const value = (await response.json()) as Discovery;
      if (
        value.issuer !== this.config.issuer ||
        ![value.authorization_endpoint, value.token_endpoint, value.jwks_uri].every(
          (u) => typeof u === 'string' && new URL(u).protocol === 'https:',
        )
      )
        throw new Error('Invalid identity provider metadata.');
      return value;
    })();
    try {
      return await this.discovery;
    } catch (e) {
      this.discovery = undefined;
      throw e;
    }
  }
  private async key(): Promise<JWTVerifyGetKey> {
    if (this.injectedKey) return this.injectedKey;
    this.jwks ??= createRemoteJWKSet(new URL((await this.metadata()).jwks_uri), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
    });
    return this.jwks;
  }
  private principal(payload: JWTPayload, authentication: Principal['authentication']): Principal {
    if (
      !payload.sub ||
      payload.sub.length > 256 ||
      payload.facility_id !== this.config.facilityId ||
      !Array.isArray(payload.roles)
    )
      throw new HttpError(403, 'Token lacks an authorized subject, facility or roles.');
    const allowed = payload.roles.filter((r): r is Role => roles.includes(r as Role));
    if (!allowed.length) throw new HttpError(403, 'No platform role assigned.');
    return {
      subject: `${this.config.issuer}|${payload.sub}`,
      name: typeof payload.name === 'string' ? payload.name : payload.sub,
      roles: allowed,
      authentication,
    };
  }
  async verifyBearer(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, await this.key(), {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['exp', 'iat', 'sub'],
        clockTolerance: 5,
        maxTokenAge: '1h',
      });
      return this.principal(payload, 'bearer');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(401, 'Invalid or expired access token.');
    }
  }
  async authenticate(req: IncomingMessage): Promise<Principal> {
    const authorization = req.headers.authorization;
    if (authorization) {
      if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'Bearer token required.');
      return this.verifyBearer(authorization.slice(7));
    }
    const session = cookie(req, '__Host-reserve_session');
    if (!session) throw new HttpError(401, 'Sign in to continue.');
    try {
      const { payload } = await jwtDecrypt(session, this.config.sessionKey!, {
        issuer: 'reserve-platform',
        audience: this.config.clientId,
        clockTolerance: 0,
      });
      if (
        !payload.sub ||
        !Array.isArray(payload.roles) ||
        typeof payload.csrf !== 'string' ||
        payload.facility_id !== this.config.facilityId
      )
        throw new Error('Invalid session.');
      return {
        subject: payload.sub,
        name: String(payload.name ?? payload.sub),
        roles: payload.roles.filter((r): r is Role => roles.includes(r as Role)),
        authentication: 'session',
        csrf: payload.csrf,
      };
    } catch {
      throw new HttpError(401, 'Session expired. Sign in again.');
    }
  }
  checkMutation(req: IncomingMessage, principal: Principal): void {
    const origin = req.headers.origin;
    if (origin && origin !== this.config.origin)
      throw new HttpError(403, 'Cross-origin mutations are disabled.');
    if (
      principal.authentication === 'session' &&
      (!origin ||
        typeof req.headers['x-csrf-token'] !== 'string' ||
        !safeEqual(req.headers['x-csrf-token'], principal.csrf!))
    )
      throw new HttpError(403, 'A valid origin and CSRF token are required.');
  }
  async login(res: ServerResponse): Promise<void> {
    const metadata = await this.metadata(),
      verifier = random(),
      state = random(),
      nonce = random();
    const transaction = await new EncryptJWT({ verifier, state, nonce })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuer('reserve-login')
      .setAudience(this.config.clientId!)
      .setIssuedAt()
      .setExpirationTime('5m')
      .encrypt(this.config.sessionKey!);
    const url = new URL(metadata.authorization_endpoint);
    for (const [k, v] of Object.entries({
      client_id: this.config.clientId!,
      redirect_uri: this.config.origin + '/auth/callback',
      response_type: 'code',
      scope: 'openid profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(k, v);
    res.writeHead(302, {
      Location: url.href,
      'Cache-Control': 'no-store',
      'Set-Cookie': `__Host-reserve_login=${transaction}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
    });
    res.end();
  }
  async callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const transaction = cookie(req, '__Host-reserve_login');
    if (!transaction || !url.searchParams.get('code'))
      throw new HttpError(400, 'Invalid login callback.');
    let saved: JWTPayload;
    try {
      saved = (
        await jwtDecrypt(transaction, this.config.sessionKey!, {
          issuer: 'reserve-login',
          audience: this.config.clientId,
        })
      ).payload;
    } catch {
      throw new HttpError(400, 'Login expired.');
    }
    if (
      typeof saved.state !== 'string' ||
      typeof saved.verifier !== 'string' ||
      !safeEqual(url.searchParams.get('state') ?? '', saved.state)
    )
      throw new HttpError(400, 'Login state mismatch.');
    const fields = new URLSearchParams({
      grant_type: 'authorization_code',
      code: url.searchParams.get('code')!,
      redirect_uri: this.config.origin + '/auth/callback',
      client_id: this.config.clientId!,
      code_verifier: saved.verifier,
    });
    if (this.config.clientSecret) fields.set('client_secret', this.config.clientSecret);
    const response = await fetch((await this.metadata()).token_endpoint, {
      method: 'POST',
      body: fields,
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) throw new HttpError(401, 'Identity provider rejected the login.');
    const tokens = (await response.json()) as { access_token: string; id_token: string };
    const identity = await jwtVerify(tokens.id_token, await this.key(), {
      issuer: this.config.issuer,
      audience: this.config.clientId,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    if (identity.payload.nonce !== saved.nonce)
      throw new HttpError(401, 'Identity token nonce mismatch.');
    const principal = await this.verifyBearer(tokens.access_token);
    if (principal.subject !== `${this.config.issuer}|${identity.payload.sub}`)
      throw new HttpError(401, 'Token subjects do not match.');
    const access = (
      await jwtVerify(tokens.access_token, await this.key(), {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256', 'ES256'],
      })
    ).payload;
    const expires = Math.min(Math.floor(Date.now() / 1000) + 900, access.exp!);
    const session = await new EncryptJWT({
      name: principal.name,
      roles: principal.roles,
      csrf: random(),
      facility_id: this.config.facilityId,
    })
      .setSubject(principal.subject)
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuer('reserve-platform')
      .setAudience(this.config.clientId!)
      .setIssuedAt()
      .setExpirationTime(expires)
      .encrypt(this.config.sessionKey!);
    res.writeHead(302, {
      Location: '/',
      'Cache-Control': 'no-store',
      'Set-Cookie': [
        `__Host-reserve_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, expires - Math.floor(Date.now() / 1000))}`,
        '__Host-reserve_login=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      ],
    });
    res.end();
  }
  logout(res: ServerResponse): void {
    res.writeHead(204, {
      'Set-Cookie': '__Host-reserve_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      'Cache-Control': 'no-store',
    });
    res.end();
  }
}

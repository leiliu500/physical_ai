# Bedrock Physical AI assistant

The operations assistant calls Amazon Bedrock Runtime's Converse API using the exact model `openai.gpt-oss-120b-1:0`. AWS credentials stay server-side. No OpenAI API key or browser credential is used. This is a text planning model; it does not replace an inspection model, a robot motion controller or the local safety controller.

## Production flow

The system prompt lives in [`src/ai/prompts/physical-ai-operations.md`](../src/ai/prompts/physical-ai-operations.md).
The service reads this file and appends the JSON schema generated from its TypeScript contract.
Builds copy the prompt into the server artifact, and the Docker image includes it with the AI module.
Edit the Markdown instructions, rebuild and rerun validation before releasing a prompt change.

Authenticated operators open **AI operations**, enter a request and generate recommendations. The server selects the registered device readings, permitted destinations and pending reviews to send to Bedrock. Device keys, OIDC secrets, database credentials and observation history are excluded from this context. The request is bounded to 2,000 characters and the context to 40 devices and 40 pending reviews.

The model returns a strict JSON object containing summary, observations, recommendations and limitations. Transfers must reference an enrolled robot and an authorized destination; review links must identify a currently pending review. Invalid schema, invented identifiers, incomplete answers and AWS errors fail explicitly. Reasoning traces are not returned or stored. The service records audit events before inference and after validated recommendations, including model ID, context/result digests and token usage; raw prompt text is not recorded.

Advice creates no command and grants no approval. An operator may prepare a transfer form, open the review workspace or prepare an inhibition reason. Each requires explicit submission to the existing controller, which rechecks role, freshness, capabilities and interlocks. Quarantine still requires two distinct supervisors. The model cannot release dispatch or approve its own recommendation.

## Server configuration

| Setting              | Default                                           |
| -------------------- | ------------------------------------------------- |
| `BEDROCK_ENABLED`    | `false` locally; Terraform enables it by default  |
| `BEDROCK_REGION`     | `AWS_REGION` or `us-gov-west-1`                   |
| `BEDROCK_MODEL_ID`   | `openai.gpt-oss-120b-1:0`; other IDs are rejected |
| `BEDROCK_MAX_TOKENS` | 2048; allowed 512–4096                            |
| `BEDROCK_TIMEOUT_MS` | 45000; allowed 5000–60000                         |

SDK retries are disabled for inference. Production limits planning to six requests per principal per minute and two concurrent requests. The ECS task role receives only `bedrock:InvokeModel` on the regional ARN for this foundation model. Your account must have usable model access and quota.

## Local simulation with a real LLM

This deployment defaults to AWS GovCloud West (`us-gov-west-1`), with model ARN
`arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/openai.gpt-oss-120b-1:0`.
GovCloud credentials authenticate in the `aws-us-gov` partition. Sending them to a commercial
region such as `us-east-1` can return `InvalidClientTokenId` even when the credentials file is correct.
Use the matching region for STS, Bedrock, Terraform and the state backend. See
[AWS partition boundaries](https://docs.aws.amazon.com/whitepapers/latest/aws-fault-isolation-boundaries/partitions.html)
and the [model's regional availability](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html).

On Node.js 24, use the existing credentials file and refreshed temporary credentials:

```powershell
$env:AWS_SHARED_CREDENTIALS_FILE = 'D:\Lei.Liu\.aws\credentials'
$env:AWS_PROFILE = 'continue_dev_profile'
$env:AWS_REGION = 'us-gov-west-1'
aws sts get-caller-identity --region us-gov-west-1
npm run simulation:bedrock
```

Open `http://localhost:4174/#assistant`. The loopback preview server sends the synthetic browser snapshot to Bedrock. It requires a matching loopback Origin, JSON content type and custom request header, rejects production-context messages, and limits calls. No CORS proxy or public endpoint is opened. Restart the preview after replacing temporary credentials so the AWS SDK refreshes its credential cache.

Use `npm run bedrock:smoke` after a build for one real inference on an empty synthetic facility snapshot. This incurs Bedrock inference usage. An expired or inconsistent access-key/secret-key/session-token set results in a clear failure; the application does not substitute a fabricated answer.

`npm run simulation` keeps Bedrock disabled. The private static Sites publication has no server-side AWS identity or Bedrock bridge; its assistant workspace accurately reports that planning is unavailable. The Terraform deployment supplies the real backend. See the [AWS deployment guide](../../infra/terraform/README.md).

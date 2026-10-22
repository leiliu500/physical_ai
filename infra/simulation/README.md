# GovCloud simulation deployment

This stack deploys the isolated Physical AI simulation with a real Amazon Bedrock
assistant. It uses an AWS-generated HTTP Application Load Balancer hostname, a private
ECS Fargate task, an immutable ECR image, CodeBuild, encrypted S3 source/state storage,
KMS and CloudWatch logs. Synthetic device activity runs in each browser tab. No physical
equipment gateway or production device registry is connected.

The task role can invoke only `openai.gpt-oss-120b-1:0` in `us-gov-west-1`. AWS credentials
stay in the task role. Planning requires the configured ALB origin and accepts simulation
context only. Replies pass the same strict schema and identifier checks as the local
assistant. Rate and concurrency limits apply.

## Prepare the image source

Use Node.js 24 in `fed-physical-ai`:

```powershell
npm ci
npm run build:simulation
node build/scripts/package-aws-build.js
```

The source packager uses an explicit list of application files. It excludes local AWS
credentials, environment files, Git metadata, installed dependencies and generated output.
CodeBuild builds `Dockerfile.simulation` and pushes a content-tagged image. ECS uses its
resolved SHA-256 digest. Docker is not needed on the deployment machine.

## Plan and deploy

Create an ignored deployment variable file containing your approved public IPv4 client
CIDRs. `allowed_ingress_cidrs` rejects unrestricted `0.0.0.0/0` access. The default profile
is `continue_dev_profile`, loaded from `D:/Lei.Liu/.aws/credentials`; it can be overridden
through Terraform variables. The region is GovCloud West.

From the repository root:

```powershell
terraform -chdir=infra/simulation init -backend-config=<backend.hcl>
terraform -chdir=infra/simulation validate
terraform -chdir=infra/simulation plan -var-file=<deployment.tfvars.json> -out=<deployment.tfplan>
terraform -chdir=infra/simulation apply <deployment.tfplan>
terraform -chdir=infra/simulation output -raw application_url
```

Copy `backend.hcl.example` to an ignored local path and pass its absolute path to
`init`. The example identifies the deployed GovCloud stack's existing state bucket
and KMS key. A new account must first provision its own encrypted, versioned state
bucket and update those references. Backend credentials use the local profile;
credential values never belong in HCL. S3 state locking is enabled.

Terraform's CodeBuild action waits for the image build. The ECS service then starts the
simulation server on port 4174 and waits for healthy `/health/live` checks. The runtime
filesystem is read-only and the process runs without root privileges. The ECS task has no
public IP; the ALB alone accepts client traffic from the configured CIDRs.

The URL intentionally uses HTTP to match the requested ALB access pattern. Use synthetic
data only. Configure your current browser/VPN egress CIDR before opening it; a different
network is blocked by the load balancer security group. Add a domain and HTTPS certificate
before extending this deployment to sensitive inputs.

The source/state bucket is private, versioned and encrypted. Preserve state and the KMS
key. A deliberate teardown must account for retained S3 versions and ECR images; automatic
destructive cleanup is disabled.

The deployed application URL is
<http://physical-ai-sim-dev-alb-212597329.us-gov-west-1.elb.amazonaws.com>.
The current ingress range is `3.83.200.219/32`; update the deployment variable file
and apply its reviewed Terraform plan when the approved client network changes.

References: [Terraform CodeBuild action](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/actions/codebuild_start_build),
[Bedrock model availability](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html).

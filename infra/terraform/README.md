# AWS deployment

This Terraform stack deploys and starts the TypeScript production control service on ECS Fargate. A release apply runs the database bootstrap task, requires its successful exit, starts one controller container and waits for the service to become healthy. The stack includes an HTTPS Application Load Balancer, private application subnets, NAT egress in two availability zones, encrypted Multi-AZ PostgreSQL 17, ECR, KMS, Secrets Manager and CloudWatch logs. Client HTTPS access is restricted to the CIDRs you supply. Bedrock uses the exact model `openai.gpt-oss-120b-1:0` through the task's IAM role.

Terraform code belongs in this repository. `D:\Lei.Liu\.aws\credentials` is the local authentication source; it is never a deployment destination and is not copied into an image, task definition or Terraform state.

## Prerequisites

- Terraform 1.11+, AWS CLI and valid `continue_dev_profile` credentials in the specified file.
- An approved AWS GovCloud account in `us-gov-west-1` (the default). Commercial deployments may explicitly select `us-east-1`, `us-east-2` or `us-west-2` with matching commercial credentials and resources.
- An existing encrypted/versioned S3 Terraform state bucket, with permission to use S3 state locking. Backend configuration is separate from provider configuration.
- A DNS name, an issued ACM certificate covering it in the selected region, and optional Route 53 zone ID.
- Your organization's OIDC issuer, resource API audience and confidential client ID. Register `https://<service_domain>/auth/callback`; resource tokens must contain the application's facility/role claims.
- An existing Secrets Manager JSON secret with exactly `OIDC_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`, `DEVICE_KEYS_JSON`, `MODEL_REGISTRY_JSON`, and `SAFETY_POLICY_JSON`. Supply approved device identities, model provenance and equipment policy as described in the application operations guide. Pass its ARN only to Terraform. If it uses a customer-managed KMS key, add that key ARN to `additional_secret_kms_arns`.
- Docker or your approved image-build service to build and push the application image.
- Node.js 24 and the application's installed, compiled deployment utilities on the machine running Terraform. Terraform invokes the TypeScript bootstrap runner during a release apply; it does not read completed Terraform outputs during that operation.
- The Terraform caller needs `ecs:RunTask`, `ecs:DescribeTasks` and `iam:PassRole` for the bootstrap task's execution and task roles, in addition to the permissions needed to provision the stack.

## Configure and review

In PowerShell, configure the local AWS process without embedding credential values:

```powershell
$env:AWS_SHARED_CREDENTIALS_FILE = 'D:\Lei.Liu\.aws\credentials'
$env:AWS_PROFILE = 'continue_dev_profile'
$env:AWS_REGION = 'us-gov-west-1'
aws sts get-caller-identity --region us-gov-west-1
```

From the repository root, copy `terraform.tfvars.example` to `terraform.tfvars` and `backend.hcl.example` to `backend.hcl` inside `infra/terraform`. Replace example values. Both completed files and state/plan files are ignored by Git.

Keep the state bucket, credentials, certificate, application secret and deployment region in the same AWS partition. The examples use `arn:aws-us-gov:` and GovCloud West. Terraform rejects certificates and application secrets from a different partition or region. GovCloud credentials sent to a commercial STS endpoint can fail with `InvalidClientTokenId`; that error alone does not establish that the credentials file is malformed. See [AWS partition boundaries](https://docs.aws.amazon.com/whitepapers/latest/aws-fault-isolation-boundaries/partitions.html).

```powershell
terraform -chdir=infra/terraform init -backend-config=backend.hcl
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -var=deploy_service=false -out=infrastructure.tfplan
```

The default `deploy_service=true` starts the controller as part of a release and requires a pinned image digest. The explicit `-var=deploy_service=false` above provisions the initial infrastructure while ECR is still empty. That infrastructure apply creates the network, database and load balancer and incurs normal AWS charges. No infrastructure is applied by the application build or test commands.

## Publish an immutable image

Apply the reviewed infrastructure plan, then build and push the same image tag configured in `terraform.tfvars` (default `release`). Use a new tag for each release because ECR tags are immutable.

```powershell
terraform -chdir=infra/terraform apply infrastructure.tfplan
$imageRepository = terraform -chdir=infra/terraform output -raw ecr_repository_url
$imageRegistry = $imageRepository.Split('/')[0]
aws ecr get-login-password --region $env:AWS_REGION | docker login --username AWS --password-stdin $imageRegistry
docker build --platform linux/amd64 -t "${imageRepository}:release" ./fed-physical-ai
docker push "${imageRepository}:release"
```

The image includes the AWS RDS public trust bundle. The application keeps certificate validation enabled for database connections. The runtime retrieves secrets with its task role and constructs the database connection URL in memory.

## Release through Terraform

Build local utilities using Node.js 24 from `fed-physical-ai`. Terraform will use this compiled runner to launch and verify the one-off ECS bootstrap task:

```powershell
npm ci
npm run build
```

Back at the repository root, read the pushed image's digest:

```powershell
$repositoryName = $imageRepository.Split('/')[-1]
aws ecr describe-images --repository-name $repositoryName --image-ids imageTag=release --query 'imageDetails[0].imageDigest' --output text
```

Put that `sha256:...` value in `image_digest` and keep `deploy_service=true` in your local Terraform variables. Review and apply the release plan:

```powershell
terraform -chdir=infra/terraform plan -out=release.tfplan
terraform -chdir=infra/terraform apply release.tfplan
terraform -chdir=infra/terraform output application_url
terraform -chdir=infra/terraform output readiness_url
```

Terraform performs these steps in order:

1. Verify that the pinned image exists in ECR and register the bootstrap and controller task definitions.
2. Run one private Fargate bootstrap task through an apply-only provisioner. Wait for the actual `controller` container to stop with exit code zero. A start failure, timeout, missing exit evidence or nonzero exit stops the release.
3. Create or update `aws_ecs_service.app` with `desired_count=1`. The application container explicitly runs `node build/src/server.js`.
4. Wait for ECS steady state and successful `/health/ready` checks, then require the requested task definition to remain active. A release has a 30-minute service timeout and an ECS rollback circuit breaker.

The provisioner receives only resource identifiers and the deployment region through environment variables. AWS credentials come from the selected local profile or workload identity. It runs only during apply and is replaced when the bootstrap task definition or pinned image changes. Plan and offline tests do not launch tasks. The optional `npm run aws:bootstrap -- ../infra/terraform` utility remains available for an explicitly requested recovery operation after infrastructure exists.

The bootstrap role can read the RDS-managed administrator secret and write the runtime database secret. It applies migrations, creates the `physical_ai_app` login, and grants state SELECT/INSERT/UPDATE, audit SELECT/INSERT and migration metadata SELECT. The running controller cannot read the administrator secret, own audit tables or perform migrations. Application and bootstrap roles are separate.

The application is a single-controller service. Stop-before-start deployments preserve its exclusive PostgreSQL controller lease and involve a brief outage; do not increase replicas. Startup inhibits dispatch and clears prior unsent authorizations. Use an approved maintenance window for schema changes that are incompatible with the previous application version, first applying `deploy_service=false` to stop the controller. Readiness and Bedrock access still need verification in the actual account after deployment.

Configure a DNS alias to the ALB if `route53_zone_id` is unset. TLS terminates at the ALB; port 4173 HTTP is restricted to the private application security group. PostgreSQL and AWS service connections use validated TLS. Configure organizational alarm routing, network controls and log retention before operating equipment; this stack makes no Federal Reserve or safety-certification claim.

## Validation without AWS access

```powershell
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform test
```

The test suite uses a mocked provider and only plan operations. It checks private networking, encryption, secret references, exact-model IAM, immutable image release, automatic bootstrap inclusion, explicit server startup, health waiting, single-controller rollout and distinct OIDC audiences. TypeScript tests cover bootstrap task failures and unconfirmed container outcomes. Passing these checks does not replace a real account plan/apply or container integration test.

Database and ALB deletion protection are enabled. For a deliberate teardown, review deletion protection and provide a unique final database snapshot name; preserve state and audit backups. Secret deletion uses a 30-day recovery period.

References: [AWS model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html), [Bedrock Converse SDK](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/command/ConverseCommand/), [RDS TLS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html), [Terraform mock providers](https://developer.hashicorp.com/terraform/language/tests/mocking).

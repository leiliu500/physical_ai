# Physical AI Operations

The TypeScript application is in [fed-physical-ai](fed-physical-ai/README.md). It provides authenticated fleet and facility monitoring, model-provenance checks, governed reviews and signed physical command tracking.

Version 2 requires organization OIDC, PostgreSQL, approved safety policy and registered device integrations. It starts empty and does not manufacture observations or execution results. See the application [deployment guide](fed-physical-ai/docs/OPERATIONS.md) and [validation scope](fed-physical-ai/docs/VALIDATION.md).

A separate [simulation workspace](fed-physical-ai/docs/SIMULATION.md) now provides moving robots, sensor trends, inspection exceptions and governed reviews without hardware. From `fed-physical-ai`, use Node.js 24 and run `npm run simulation`. Simulation is explicitly labeled and isolated from the production deployment.

The optional [AI operations assistant](fed-physical-ai/docs/BEDROCK.md) uses Amazon Bedrock model `openai.gpt-oss-120b-1:0` to suggest actions for human review. AWS credentials remain on the server; recommendations pass the existing controller before any equipment command can be sent. The [system prompt](fed-physical-ai/src/ai/prompts/physical-ai-operations.md) is maintained separately in Markdown. Use `npm run simulation:bedrock` for a local simulation with real Bedrock inference; the default region is GovCloud West (`us-gov-west-1`).

[Terraform deployment code](infra/terraform/README.md) provisions a private ECS Fargate service, HTTPS load balancer, PostgreSQL, Secrets Manager integration and scoped Bedrock permissions. A release apply verifies the pinned image, runs database bootstrap, starts the controller server and waits for healthy service state. Deployment requires organization configuration and valid AWS credentials; no infrastructure is provisioned by building or testing this repository.

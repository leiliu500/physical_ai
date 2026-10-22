import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runDatabaseBootstrap } from '../src/deployment/ecs-bootstrap.js';

let config: unknown;
if (process.argv[2] === '--from-terraform') {
  if (!process.env.ECS_BOOTSTRAP_CONFIG)
    throw new Error('Terraform did not supply ECS_BOOTSTRAP_CONFIG.');
  config = JSON.parse(process.env.ECS_BOOTSTRAP_CONFIG);
} else {
  const directory = resolve(process.argv[2] ?? '../infra/terraform');
  const terraform = process.platform === 'win32' ? 'terraform.exe' : 'terraform';
  const outputs = JSON.parse(
    execFileSync(terraform, [`-chdir=${directory}`, 'output', '-json'], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  ) as Record<string, { value: unknown }>;
  config = {
    region: outputs.aws_region?.value,
    cluster: outputs.cluster_arn?.value,
    taskDefinition: outputs.bootstrap_task_definition_arn?.value,
    subnets: outputs.private_subnet_ids?.value,
    securityGroup: outputs.task_security_group_id?.value,
  };
}
await runDatabaseBootstrap(config, undefined, console.log);

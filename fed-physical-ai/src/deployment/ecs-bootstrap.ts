import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  waitUntilTasksStopped,
  type RunTaskCommandInput,
  type RunTaskCommandOutput,
  type DescribeTasksCommandInput,
  type DescribeTasksCommandOutput,
} from '@aws-sdk/client-ecs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const bootstrapConfigSchema = z
  .object({
    region: z.enum(['us-gov-west-1', 'us-east-1', 'us-east-2', 'us-west-2']),
    cluster: z.string().regex(/^arn:[a-z-]+:ecs:[a-z0-9-]+:\d{12}:cluster\/[A-Za-z0-9_-]+$/),
    taskDefinition: z
      .string()
      .regex(/^arn:[a-z-]+:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:\d+$/),
    subnets: z
      .array(z.string().regex(/^subnet-[a-f0-9]+$/))
      .min(1)
      .max(16),
    securityGroup: z.string().regex(/^sg-[a-f0-9]+$/),
  })
  .strict()
  .superRefine((value, context) => {
    const partition = value.region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
    const prefix = `arn:${partition}:ecs:${value.region}:`;
    if (!value.cluster.startsWith(prefix) || !value.taskDefinition.startsWith(prefix))
      context.addIssue({
        code: 'custom',
        message: 'Bootstrap ARNs must match the deployment region and AWS partition.',
      });
  });
export type BootstrapConfig = z.infer<typeof bootstrapConfigSchema>;
export interface BootstrapDriver {
  run(input: RunTaskCommandInput): Promise<RunTaskCommandOutput>;
  wait(input: DescribeTasksCommandInput): Promise<void>;
  describe(input: DescribeTasksCommandInput): Promise<DescribeTasksCommandOutput>;
}

export async function runDatabaseBootstrap(
  input: unknown,
  driver?: BootstrapDriver,
  progress: (message: string) => void = () => undefined,
): Promise<string> {
  const config = bootstrapConfigSchema.parse(input);
  const client = driver ? undefined : new ECSClient({ region: config.region, maxAttempts: 2 });
  const operations: BootstrapDriver = driver ?? {
    run: (value) => client!.send(new RunTaskCommand(value)),
    wait: async (value) => {
      await waitUntilTasksStopped(
        { client: client!, maxWaitTime: 900, minDelay: 10, maxDelay: 15 },
        value,
      );
    },
    describe: (value) => client!.send(new DescribeTasksCommand(value)),
  };
  try {
    const response = await operations.run({
      cluster: config.cluster,
      taskDefinition: config.taskDefinition,
      launchType: 'FARGATE',
      platformVersion: '1.4.0',
      count: 1,
      clientToken: randomUUID(),
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.subnets,
          securityGroups: [config.securityGroup],
          assignPublicIp: 'DISABLED',
        },
      },
    });
    const taskArn = response.tasks?.[0]?.taskArn;
    if (!taskArn || response.tasks?.length !== 1 || response.failures?.length)
      throw new Error(
        'ECS did not start exactly one bootstrap task. Check task permissions and image availability.',
      );
    progress(`Bootstrap started: ${taskArn}`);
    const lookup = { cluster: config.cluster, tasks: [taskArn] };
    await operations.wait(lookup);
    const result = await operations.describe(lookup);
    const task = result.tasks?.find((value) => value.taskArn === taskArn);
    const container = task?.containers?.find((value) => value.name === 'controller');
    if (result.failures?.length || task?.lastStatus !== 'STOPPED' || container?.exitCode !== 0)
      throw new Error(
        'Bootstrap did not succeed. Inspect its CloudWatch bootstrap log stream before releasing the service.',
      );
    progress('Bootstrap succeeded. Terraform can now start the controller service.');
    return taskArn;
  } finally {
    client?.destroy();
  }
}

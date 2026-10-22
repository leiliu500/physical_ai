resource "aws_cloudwatch_log_group" "app" {
  name              = "/physical-ai/${local.name}/service"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.app.arn
}
locals {
  task_trust = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = local.account } } }] })
}
resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = local.task_trust
}
resource "aws_iam_role_policy" "execution" {
  role = aws_iam_role.execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = aws_ecr_repository.app.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = [aws_cloudwatch_log_group.app.arn, "${aws_cloudwatch_log_group.app.arn}:log-stream:*"] }
  ] })
}
resource "aws_iam_role" "app" {
  name               = "${local.name}-bedrock"
  assume_role_policy = local.task_trust
}
resource "aws_iam_role_policy" "app" {
  role   = aws_iam_role.app.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = local.model_arn }] })
}
resource "aws_ecs_cluster" "app" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}
resource "aws_lb" "app" {
  name                       = "${local.name}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  idle_timeout               = 75
}
resource "aws_lb_target_group" "app" {
  name        = "${local.name}-tg"
  port        = 4174
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.app.id
  health_check {
    path                = "/health/live"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}
resource "aws_lb_listener" "app" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name            = "simulation", image = "${aws_ecr_repository.app.repository_url}@${data.aws_ecr_image.release.image_digest}", essential = true, user = "1000", readonlyRootFilesystem = true,
    command         = ["node", "build/scripts/serve-simulation.js"],
    linuxParameters = { capabilities = { add = [], drop = ["ALL"] } },
    mountPoints     = [],
    systemControls  = [],
    volumesFrom     = [],
    portMappings    = [{ containerPort = 4174, hostPort = 4174, protocol = "tcp" }],
    environment = [for key, value in {
      AWS_REGION         = var.aws_region, BEDROCK_REGION = var.aws_region, BEDROCK_ENABLED = "true", BEDROCK_MODEL_ID = "openai.gpt-oss-120b-1:0",
      BEDROCK_MAX_TOKENS = "2048", BEDROCK_TIMEOUT_MS = "45000", SIMULATION_PUBLIC_ORIGIN = "http://${aws_lb.app.dns_name}"
    } : { name = key, value = value }],
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.app.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "simulation" } },
    healthCheck      = { command = ["CMD", "node", "-e", "fetch('http://127.0.0.1:4174/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval = 30, timeout = 5, retries = 3, startPeriod = 30 }
  }])
}
resource "aws_ecs_service" "app" {
  name                              = local.name
  cluster                           = aws_ecs_cluster.app.id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = 1
  launch_type                       = "FARGATE"
  platform_version                  = "1.4.0"
  wait_for_steady_state             = true
  health_check_grace_period_seconds = 60
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "simulation"
    container_port   = 4174
  }
  depends_on = [aws_lb_listener.app, aws_iam_role_policy.execution, aws_iam_role_policy.app, aws_route.private]
  timeouts {
    create = "30m"
    update = "30m"
  }
  lifecycle {
    postcondition {
      condition     = self.task_definition == aws_ecs_task_definition.app.arn
      error_message = "The service rolled back instead of starting the requested image."
    }
  }
}
output "application_url" {
  value = "http://${aws_lb.app.dns_name}"
}
output "cluster_name" {
  value = aws_ecs_cluster.app.name
}
output "service_name" {
  value = aws_ecs_service.app.name
}
output "image_digest" {
  value = data.aws_ecr_image.release.image_digest
}
output "state_bucket" {
  value = aws_s3_bucket.artifacts.id
}
output "allowed_ingress_cidrs" {
  value = var.allowed_ingress_cidrs
}
output "build_project" {
  value = aws_codebuild_project.app.name
}

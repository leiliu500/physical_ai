resource "aws_ecs_cluster" "app" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  log_configuration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.app.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "controller" } }
  common_container  = { name = "controller", image = local.image, essential = true, user = "1000", readonlyRootFilesystem = true, linuxParameters = { capabilities = { drop = ["ALL"] } }, logConfiguration = local.log_configuration }
  app_environment = {
    NODE_ENV         = "production", HOST = "0.0.0.0", PORT = "4173", AWS_REGION = var.aws_region,
    PUBLIC_ORIGIN    = "https://${var.service_domain}", FACILITY_ID = var.facility_id,
    OIDC_ISSUER      = var.oidc_issuer, OIDC_AUDIENCE = var.oidc_audience, OIDC_CLIENT_ID = var.oidc_client_id,
    APP_SECRET_ARN   = var.app_secret_arn, DATABASE_SECRET_ARN = aws_secretsmanager_secret.database.arn,
    DATABASE_TLS     = "true", BEDROCK_ENABLED = tostring(var.bedrock_enabled), BEDROCK_REGION = var.aws_region,
    BEDROCK_MODEL_ID = local.model_id, BEDROCK_MAX_TOKENS = "2048", BEDROCK_TIMEOUT_MS = "45000"
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name}-controller"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([merge(local.common_container, {
    command      = ["node", "build/src/server.js"],
    portMappings = [{ containerPort = 4173, protocol = "tcp" }],
    environment  = [for key, value in local.app_environment : { name = key, value = value }],
    healthCheck  = { command = ["CMD", "node", "-e", "fetch('http://127.0.0.1:4173/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval = 30, timeout = 5, retries = 3, startPeriod = 60 }
  })])
  lifecycle {
    precondition {
      condition     = startswith(var.certificate_arn, "arn:${data.aws_partition.current.partition}:acm:${var.aws_region}:")
      error_message = "The ACM certificate must belong to the deployment partition and region."
    }
    precondition {
      condition     = startswith(var.app_secret_arn, "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:")
      error_message = "The application secret must belong to the deployment partition and region."
    }
    precondition {
      condition     = var.oidc_audience != var.oidc_client_id
      error_message = "OIDC resource API audience and web client identifier must be distinct."
    }
  }
}

resource "aws_ecs_task_definition" "bootstrap" {
  family                   = "${local.name}-bootstrap"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.bootstrap.arn
  container_definitions = jsonencode([merge(local.common_container, {
    command = ["node", "build/scripts/bootstrap-aws.js"],
    environment = [for key, value in {
      AWS_REGION    = var.aws_region
      DATABASE_HOST = aws_db_instance.app.address
      DATABASE_NAME = aws_db_instance.app.db_name

      DATABASE_SECRET_ARN  = aws_secretsmanager_secret.database.arn
      DB_MASTER_SECRET_ARN = aws_db_instance.app.master_user_secret[0].secret_arn
      }
    : { name = key, value = value }],
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.app.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "bootstrap" } }
  })])
}

resource "aws_lb" "app" {
  name                       = "${local.name}-alb"
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  idle_timeout               = 75
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "app" {
  name                 = "${local.name}-tg"
  port                 = 4173
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.app.id
  deregistration_delay = 30
  health_check {
    path                = "/health/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_ecs_service" "app" {
  name                               = local.name
  cluster                            = aws_ecs_cluster.app.id
  task_definition                    = aws_ecs_task_definition.app.arn
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  desired_count                      = var.deploy_service ? 1 : 0
  wait_for_steady_state              = true
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 90
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
    container_name   = "controller"
    container_port   = 4173
  }

  depends_on = [terraform_data.bootstrap, aws_lb_listener.https, aws_iam_role_policy.execution, aws_iam_role_policy.app, aws_route.private]
  timeouts {
    create = "30m"
    update = "30m"
    delete = "20m"
  }
  lifecycle {
    precondition {
      condition     = !var.deploy_service || var.image_digest != null
      error_message = "A service release requires an immutable image digest. Terraform runs bootstrap before starting the controller."
    }
    postcondition {
      condition     = !var.deploy_service || self.task_definition == aws_ecs_task_definition.app.arn
      error_message = "The service did not retain the requested task definition. Check ECS deployment events and rollback status."
    }
  }
}

resource "aws_route53_record" "app" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.service_domain
  type    = "A"
  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}

resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  alarm_name          = "${local.name}-unhealthy-controller"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.app.arn_suffix, TargetGroup = aws_lb_target_group.app.arn_suffix }
}

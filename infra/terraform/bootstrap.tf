data "aws_ecr_image" "release" {
  count           = var.deploy_service && var.image_digest != null ? 1 : 0
  repository_name = aws_ecr_repository.app.name
  image_digest    = var.image_digest
}

resource "terraform_data" "bootstrap" {
  count = var.deploy_service ? 1 : 0

  triggers_replace = {
    task_definition = aws_ecs_task_definition.bootstrap.arn
    image_digest    = var.image_digest
    database        = aws_db_instance.app.identifier
  }

  provisioner "local-exec" {
    command     = "node build/scripts/run-aws-bootstrap.js --from-terraform"
    working_dir = abspath("${path.module}/../../fed-physical-ai")
    environment = merge({
      AWS_REGION = var.aws_region
      ECS_BOOTSTRAP_CONFIG = jsonencode({
        region         = var.aws_region
        cluster        = aws_ecs_cluster.app.arn
        taskDefinition = aws_ecs_task_definition.bootstrap.arn
        subnets        = aws_subnet.private[*].id
        securityGroup  = aws_security_group.app.id
      })
      },
      var.aws_profile == null ? {} : { AWS_PROFILE = var.aws_profile },
      length(var.aws_shared_credentials_files) == 0 ? {} : { AWS_SHARED_CREDENTIALS_FILE = var.aws_shared_credentials_files[0] }
    )
  }

  depends_on = [data.aws_ecr_image.release, aws_iam_role_policy.execution, aws_iam_role_policy.bootstrap, aws_route.private, aws_db_instance.app]
}

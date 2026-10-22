output "aws_region" {
  value = var.aws_region
}

output "application_url" {
  value = "https://${var.service_domain}"
}

output "alb_dns_name" {
  value = aws_lb.app.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.app.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.app.arn
}

output "service_arn" {
  value = aws_ecs_service.app.id
}

output "readiness_url" {
  value = "https://${var.service_domain}/health/ready"
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "bootstrap_task_definition_arn" {
  value = aws_ecs_task_definition.bootstrap.arn
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "task_security_group_id" {
  value = aws_security_group.app.id
}

output "runtime_database_secret_arn" {
  value = aws_secretsmanager_secret.database.arn
}

output "bedrock_model_id" {
  value = local.model_id
}

output "bedrock_model_arn" {
  value = local.model_arn
}

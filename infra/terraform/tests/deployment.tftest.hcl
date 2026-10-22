mock_provider "aws" {

  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012", arn = "arn:aws-us-gov:iam::123456789012:user/test" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws-us-gov", dns_suffix = "amazonaws.com" }
  }

  mock_data "aws_availability_zones" {
    defaults = { names = ["us-gov-west-1a", "us-gov-west-1b"] }
  }

  mock_data "aws_rds_engine_version" {
    defaults = { version_actual = "17.7" }
  }

  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws-us-gov:iam::123456789012:role/mock-role" }
  }

  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws-us-gov:kms:us-gov-west-1:123456789012:key/11111111-1111-1111-1111-111111111111" }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws-us-gov:logs:us-gov-west-1:123456789012:log-group:/physical-ai/mock" }
  }

  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws-us-gov:ecr:us-gov-west-1:123456789012:repository/mock", repository_url = "123456789012.dkr.ecr.us-gov-west-1.amazonaws.com/mock" }
  }

  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:runtime-AbCdEf" }
  }

  mock_resource "aws_db_instance" {
    defaults = { address = "mock.us-gov-west-1.rds.amazonaws.com", master_user_secret = [{ secret_arn = "arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:master-AbCdEf", kms_key_id = "11111111-1111-1111-1111-111111111111", secret_status = "active" }] }
  }

  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws-us-gov:elasticloadbalancing:us-gov-west-1:123456789012:loadbalancer/app/mock/1234567890123456" }
  }

  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws-us-gov:elasticloadbalancing:us-gov-west-1:123456789012:targetgroup/mock/1234567890123456" }
  }

  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws-us-gov:ecs:us-gov-west-1:123456789012:task-definition/mock:1" }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws-us-gov:ecs:us-gov-west-1:123456789012:cluster/mock" }
  }


}


variables {

  allowed_ingress_cidrs = ["203.0.113.10/32"]
  service_domain        = "physical-ai.example.org"
  certificate_arn       = "arn:aws-us-gov:acm:us-gov-west-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  oidc_issuer           = "https://identity.example.org"
  oidc_audience         = "physical-api"
  oidc_client_id        = "physical-web"
  facility_id           = "test-facility"
  app_secret_arn        = "arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:application-AbCdEf"
  image_digest          = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

}


run "bootstrap_before_service" {

  command = plan
  variables {
    deploy_service = false
  }
  assert {
    condition     = length(terraform_data.bootstrap) == 0 && length(data.aws_ecr_image.release) == 0
    error_message = "Infrastructure-only provisioning must not run the database bootstrap."
  }
  assert {
    condition     = output.aws_region == "us-gov-west-1" && local.model_arn == "arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/openai.gpt-oss-120b-1:0"
    error_message = "The default deployment must use GovCloud West and the matching model partition."
  }
  assert {
    condition     = aws_ecs_service.app.desired_count == 0
    error_message = "The service must remain stopped before database bootstrap and image publication."
  }

  assert {
    condition     = !aws_ecs_service.app.network_configuration[0].assign_public_ip && !aws_db_instance.app.publicly_accessible
    error_message = "Tasks and database must not have public addresses."
  }

  assert {
    condition     = aws_db_instance.app.storage_encrypted && aws_db_instance.app.manage_master_user_password
    error_message = "Database encryption and managed administrator credentials are required."
  }

  assert {
    condition     = aws_lb_listener.https.port == 443 && aws_lb_listener.https.protocol == "HTTPS"
    error_message = "Client ingress must use HTTPS."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.app.container_definitions)[0].readonlyRootFilesystem
    error_message = "The runtime filesystem must be read-only."
  }

  assert {
    condition     = alltrue([for item in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment : !contains(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "DATABASE_URL", "OIDC_CLIENT_SECRET"], item.name)])
    error_message = "Task definitions must not embed credentials or database passwords."
  }

  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.app.policy).Statement : statement if statement.Sid == "RequestedBedrockModelOnly"]).Resource == ["arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/openai.gpt-oss-120b-1:0"]
    error_message = "Bedrock access must be scoped to the exact requested model."
  }


}

run "release_with_digest" {

  command = plan
  variables {
    image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition     = aws_ecs_service.app.desired_count == 1 && aws_ecs_service.app.deployment_maximum_percent == 100 && aws_ecs_service.app.wait_for_steady_state
    error_message = "A release must start one controller, preserve stop-before-start deployment and wait for health."
  }

  assert {
    condition     = length(terraform_data.bootstrap) == 1 && length(data.aws_ecr_image.release) == 1 && terraform_data.bootstrap[0].triggers_replace.image_digest == var.image_digest
    error_message = "An image release must include automatic database bootstrap."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.app.container_definitions)[0].command == ["node", "build/src/server.js"]
    error_message = "The ECS container must explicitly start the TypeScript control server."
  }


}

run "disabled_bedrock_has_no_inference_permission" {

  command = plan
  variables {
    bedrock_enabled = false
  }

  assert {
    condition     = !contains(flatten([for statement in jsondecode(aws_iam_role_policy.app.policy).Statement : statement.Action]), "bedrock:InvokeModel")
    error_message = "Disabled Bedrock must not retain invocation permission."
  }


}

run "reject_unpinned_release" {

  command = plan
  variables {
    deploy_service = true
    image_digest   = null
  }

  expect_failures = [aws_ecs_service.app]

}

run "reject_shared_oidc_audience" {

  command = plan
  variables {
    oidc_audience = "physical-web"
  }

  expect_failures = [aws_ecs_task_definition.app]

}

run "reject_commercial_certificate_in_govcloud" {
  command = plan
  variables {
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  }
  expect_failures = [aws_ecs_task_definition.app]
}

run "reject_commercial_secret_in_govcloud" {
  command = plan
  variables {
    app_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:application-AbCdEf"
  }
  expect_failures = [aws_ecs_task_definition.app]
}

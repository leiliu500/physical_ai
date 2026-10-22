terraform {
  required_version = ">= 1.11, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }

  backend "s3" {
  }
}

provider "aws" {
  region                   = var.aws_region
  profile                  = var.aws_profile
  shared_credentials_files = length(var.aws_shared_credentials_files) > 0 ? var.aws_shared_credentials_files : null
  default_tags {
    tags = { Project = var.project, Environment = var.environment, ManagedBy = "Terraform" }
  }
}

data "aws_caller_identity" "current" {
}

data "aws_partition" "current" {
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_rds_engine_version" "postgres" {
  engine  = "postgres"
  version = "17"
  latest  = true
}

locals {
  name      = "${var.project}-${var.environment}"
  azs       = slice(data.aws_availability_zones.available.names, 0, 2)
  model_id  = "openai.gpt-oss-120b-1:0"
  model_arn = "arn:${data.aws_partition.current.partition}:bedrock:${var.aws_region}::foundation-model/${local.model_id}"
  image     = var.image_digest == null ? "${aws_ecr_repository.app.repository_url}:${var.image_tag}" : "${aws_ecr_repository.app.repository_url}@${var.image_digest}"
}

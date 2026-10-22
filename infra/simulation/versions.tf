terraform {
  required_version = ">= 1.14, < 2.0"
  backend "s3" {}
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" {
  region                   = var.aws_region
  profile                  = var.aws_profile
  shared_credentials_files = var.aws_shared_credentials_files
  default_tags {
    tags = { Project = "PhysicalAI", Runtime = "Simulation", ManagedBy = "Terraform" }
  }
}
variable "aws_region" {
  type    = string
  default = "us-gov-west-1"
  validation {
    condition     = var.aws_region == "us-gov-west-1"
    error_message = "This deployment uses the verified in-region GovCloud West Bedrock model."
  }
}
variable "aws_profile" {
  type    = string
  default = "continue_dev_profile"
}
variable "aws_shared_credentials_files" {
  type    = list(string)
  default = ["D:/Lei.Liu/.aws/credentials"]
}
variable "allowed_ingress_cidrs" {
  type = set(string)
  validation {
    condition     = length(var.allowed_ingress_cidrs) > 0 && alltrue([for cidr in var.allowed_ingress_cidrs : can(cidrnetmask(cidr)) && cidr != "0.0.0.0/0"])
    error_message = "Provide approved IPv4 client ranges; unrestricted public inference is disabled."
  }
}
variable "source_archive" {
  type    = string
  default = "../../fed-physical-ai/.openai/local/aws-build/source.zip"
}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}
locals {
  name        = "physical-ai-sim-dev"
  partition   = data.aws_partition.current.partition
  account     = data.aws_caller_identity.current.account_id
  source_path = abspath(var.source_archive)
  source_hash = filesha256(local.source_path)
  image_tag   = "src-${substr(local.source_hash, 0, 24)}"
  image_uri   = "${aws_ecr_repository.app.repository_url}:${local.image_tag}"
  model_arn   = "arn:${local.partition}:bedrock:${var.aws_region}::foundation-model/openai.gpt-oss-120b-1:0"
}

import type { IntegrationConfig } from "../../core/types.js";

export type GitHubCapabilityProviderName = "openclaw";
export type GitHubCapabilityOperation =
  | "listProjectIssuesByStatus"
  | "getIssue"
  | "listIssueComments"
  | "createDraftPr"
  | "postIssueComment"
  | "postPrComment"
  | "postPrReview"
  | "getPrChecks";

export type GitHubProviderErrorCategory =
  | "rate_limit"
  | "auth"
  | "not_found"
  | "server_error"
  | "unknown";

export type GitHubAuth =
  | { kind: "token"; token?: string }
  | { kind: "app-installation"; installationId: string; token?: string };

export type ProviderCallMeta = {
  requestId?: string;
  idempotencyKey?: string;
};

export type GitHubProjectIssue = {
  number: number;
  title: string;
  projectStatus: string;
  updatedAt: string;
};

export type GitHubCapabilityListIssuesArgs = {
  config: IntegrationConfig;
  statuses: string[];
  auth: GitHubAuth;
  meta?: ProviderCallMeta;
};

export type GitHubCapabilityListIssuesResult = {
  issues: GitHubProjectIssue[];
};

export type GitHubCapabilityPostIssueCommentArgs = {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  auth: GitHubAuth;
  meta?: ProviderCallMeta;
};

export type GitHubCapabilityPostIssueCommentResult = {
  ok: boolean;
  output?: string;
};

export type GitHubCapabilityCreateDraftPrArgs = {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base?: string;
  auth: GitHubAuth;
  meta?: ProviderCallMeta;
};

export type GitHubCapabilityCreateDraftPrResult = {
  number: number;
  url: string;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
};

export type GitHubCapabilityPostPrCommentArgs = {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  auth: GitHubAuth;
  meta?: ProviderCallMeta;
};

export type GitHubCapabilityPostPrCommentResult = {
  ok: boolean;
  output?: string;
};

export type GitHubPrReviewEvent = "approve" | "request_changes" | "comment";

export type GitHubCapabilityPostPrReviewArgs = {
  owner: string;
  repo: string;
  prNumber: number;
  reviewEvent: GitHubPrReviewEvent;
  body?: string;
  auth: GitHubAuth;
  meta?: ProviderCallMeta;
};

export type GitHubCapabilityPostPrReviewResult = {
  ok: boolean;
  reviewEvent: GitHubPrReviewEvent;
  output?: string;
};

export type GitHubPrCheckStatus = "success" | "pending" | "failure" | "unknown";

export type GitHubPrCheck = {
  name: string;
  status: GitHubPrCheckStatus;
  conclusion?: string;
  detailsUrl?: string;
};

export type GitHubCapabilityGetPrChecksArgs = {
  owner: string;
  repo: string;
  prNumber: number;
  auth: GitHubAuth;
  meta?: ProviderCallMeta;
};

export type GitHubCapabilityGetPrChecksResult = {
  prNumber: number;
  url?: string;
  title?: string;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  overallStatus: GitHubPrCheckStatus;
  checks: GitHubPrCheck[];
};

type GitHubCapabilityErrorArgs = {
  providerName: GitHubCapabilityProviderName;
  operation: GitHubCapabilityOperation;
  category: GitHubProviderErrorCategory;
  retryable: boolean;
  message: string;
  cause?: unknown;
};

export class GitHubCapabilityError extends Error {
  readonly providerName: GitHubCapabilityProviderName;
  readonly operation: GitHubCapabilityOperation;
  readonly category: GitHubProviderErrorCategory;
  readonly retryable: boolean;

  constructor(args: GitHubCapabilityErrorArgs) {
    super(args.message, args.cause ? { cause: args.cause } : undefined);
    this.name = "GitHubCapabilityError";
    this.providerName = args.providerName;
    this.operation = args.operation;
    this.category = args.category;
    this.retryable = args.retryable;
  }
}

export interface GitHubCapability {
  readonly providerName: GitHubCapabilityProviderName;
  listProjectIssuesByStatus(
    args: GitHubCapabilityListIssuesArgs,
  ): Promise<GitHubCapabilityListIssuesResult>;
  createDraftPr(
    args: GitHubCapabilityCreateDraftPrArgs,
  ): Promise<GitHubCapabilityCreateDraftPrResult>;
  postIssueComment(
    args: GitHubCapabilityPostIssueCommentArgs,
  ): Promise<GitHubCapabilityPostIssueCommentResult>;
  postPrComment(
    args: GitHubCapabilityPostPrCommentArgs,
  ): Promise<GitHubCapabilityPostPrCommentResult>;
  postPrReview(args: GitHubCapabilityPostPrReviewArgs): Promise<GitHubCapabilityPostPrReviewResult>;
  getPrChecks(args: GitHubCapabilityGetPrChecksArgs): Promise<GitHubCapabilityGetPrChecksResult>;
  stop?: () => Promise<void> | void;
}

import { z } from "zod";

export const gitHubProjectIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  projectStatus: z.string(),
  updatedAt: z.string(),
});

export const listProjectIssuesByStatusResultSchema = z.object({
  issues: z.array(gitHubProjectIssueSchema),
});

export const postIssueCommentResultSchema = z.object({
  ok: z.boolean(),
  output: z.string().optional(),
});

export const createDraftPrResultSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  state: z.string().optional(),
  isDraft: z.boolean().optional(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
});

export const postPrCommentResultSchema = z.object({
  ok: z.boolean(),
  output: z.string().optional(),
});

const reviewEventSchema = z.enum(["approve", "request_changes", "comment"]);

export const postPrReviewResultSchema = z.object({
  ok: z.boolean(),
  reviewEvent: reviewEventSchema,
  output: z.string().optional(),
});

const prCheckStatusSchema = z.enum(["success", "pending", "failure", "unknown"]);

export const prCheckSchema = z.object({
  name: z.string(),
  status: prCheckStatusSchema,
  conclusion: z.string().optional(),
  detailsUrl: z.string().optional(),
});

export const getPrChecksResultSchema = z.object({
  prNumber: z.number().int().positive(),
  url: z.string().optional(),
  title: z.string().optional(),
  state: z.string().optional(),
  isDraft: z.boolean().optional(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  mergeStateStatus: z.string().optional(),
  reviewDecision: z.string().optional(),
  overallStatus: prCheckStatusSchema,
  checks: z.array(prCheckSchema),
});

export const toolsInvokeSuccessEnvelopeSchema = z.object({
  ok: z.literal(true),
  result: z.unknown(),
});

export const toolsInvokeErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z
    .object({
      message: z.string().optional(),
      type: z.string().optional(),
    })
    .optional(),
});

export type ListProjectIssuesByStatusResult = z.infer<typeof listProjectIssuesByStatusResultSchema>;
export type PostIssueCommentResult = z.infer<typeof postIssueCommentResultSchema>;
export type CreateDraftPrResult = z.infer<typeof createDraftPrResultSchema>;
export type PostPrCommentResult = z.infer<typeof postPrCommentResultSchema>;
export type PostPrReviewResult = z.infer<typeof postPrReviewResultSchema>;
export type GetPrChecksResult = z.infer<typeof getPrChecksResultSchema>;

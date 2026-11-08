/**
 * The routes of a thread's review and the questions a person answers: starting and cancelling a review, landing its
 * pull request, and answering a question. The server registers its handlers against them, and the CLI and dashboard
 * call them. It imports nothing at run time, so a browser can bundle it. reviews-parse.ts holds the request schemas.
 */
import type { z } from "zod";
import type { Review } from "../control/review-model.ts";
import type { Question } from "../control/questions.ts";
import type { answerSchema, landSchema, reviewSchema } from "./reviews-parse.ts";
import { route } from "./route.ts";

export type { Review } from "../control/review-model.ts";
export type { Question } from "../control/questions.ts";

export const reviewRoutes = {
  start: route<Review, z.input<typeof reviewSchema>>()("POST", "/v1/threads/{thread}/review"),
  cancel: route<Review>()("POST", "/v1/threads/{thread}/review/cancel"),
  land: route<Review, z.input<typeof landSchema>>()("POST", "/v1/threads/{thread}/land"),
} as const;

export const questionRoutes = {
  answer: route<Question, z.input<typeof answerSchema>>()("POST", "/v1/questions/{question}/answer"),
} as const;

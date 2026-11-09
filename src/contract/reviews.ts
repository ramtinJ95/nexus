/** It imports only route.ts at run time, so a browser can bundle it. */
import type { z } from "zod";
import type { Review } from "../control/review-model.ts";
import type { Question } from "../control/questions.ts";
import type { answerSchema, landSchema, reviewSchema } from "./reviews-parse.ts";
import { route } from "./route.ts";

export type { Review } from "../control/review-model.ts";
export type { Question } from "../control/questions.ts";

/** A holds question's options. Land on it is a Land press waiving the holds it names. */
export const landOption = "Land";
export const holdOptions = [landOption, "Leave it"] as const;

/** A review as its routes reply: the record, and its lines as `nexus` prints them. A control plane older than 0.73.0 sends no `said`. */
export type SaidReview = Review & { said?: readonly string[] };

export const reviewRoutes = {
  start: route<SaidReview, z.input<typeof reviewSchema>>()("POST", "/v1/threads/{thread}/review"),
  cancel: route<SaidReview>()("POST", "/v1/threads/{thread}/review/cancel"),
  land: route<SaidReview, z.input<typeof landSchema>>()("POST", "/v1/threads/{thread}/land"),
} as const;

export const questionRoutes = {
  answer: route<Question, z.input<typeof answerSchema>>()("POST", "/v1/questions/{question}/answer"),
} as const;

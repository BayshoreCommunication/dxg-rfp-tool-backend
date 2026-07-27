import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import {
  PlatformAssistantError,
  parseAssistantIdempotencyKey,
  parseAssistantMessageInput,
  parseAssistantThreadId,
  type PlatformAssistantContext,
} from "../src/modules/platformAssistant/domain";
import {
  platformAssistantApplication,
  platformAssistantStreamingApplication,
} from "../src/modules/platformAssistant/composition";
import {
  assistantOperationalLimiter,
  type AssistantOperationalLimiter,
} from "../src/modules/platformAssistant/operationalLimits";
import { assistantRuntimeConfig } from "../src/modules/platformAssistant/config";
import type { AssistantProductStreamEvent } from "../src/modules/platformAssistant/streamingApplication";

type AssistantApplication = typeof platformAssistantApplication;
type AssistantStreamingApplication =
  typeof platformAssistantStreamingApplication;

const context = (req: AuthRequest): PlatformAssistantContext => {
  if (!req.user?.organizationId || !req.user.userId) {
    throw new PlatformAssistantError(
      "AUTHENTICATION_REQUIRED",
      "Authentication required.",
      401,
    );
  }
  const requestCorrelation = (req as AuthRequest & { correlationId?: string })
    .correlationId;
  return {
    organizationMongoId: req.user.organizationId,
    actorUserMongoId: req.user.userId,
    correlationId:
      requestCorrelation ||
      String(req.headers["x-correlation-id"] || crypto.randomUUID()),
  };
};

const requireJson = (req: AuthRequest): void => {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new PlatformAssistantError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Assistant requests must use application/json.",
      415,
    );
  }
};

const idempotencyKey = (req: AuthRequest): string =>
  parseAssistantIdempotencyKey(req.headers["idempotency-key"]);

const responseIdempotencyKey = (req: AuthRequest): string | undefined => {
  const value = req.headers["assistant-response-idempotency-key"];
  return value === undefined ? undefined : parseAssistantIdempotencyKey(value);
};

const cursorDate = (value: unknown): Date | null => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new PlatformAssistantError(
      "INVALID_ASSISTANT_PAGINATION",
      "The thread cursor is invalid.",
      422,
    );
  }
  return parsed;
};

export const writePlatformAssistantProblem = (
  res: Response,
  error: unknown,
  fallbackCorrelationId?: string,
): void => {
  const known = error instanceof PlatformAssistantError ? error : null;
  const status = known?.status ?? 500;
  const code = known?.code ?? "INTERNAL_ERROR";
  const correlationId =
    fallbackCorrelationId || String(res.getHeader("X-Correlation-ID") || "");
  if (known?.retryAfterSeconds) {
    res.setHeader("Retry-After", known.retryAfterSeconds);
  }
  res
    .status(status)
    .type("application/problem+json")
    .json({
      type: `https://api.rfpilot.example/problems/${code
        .toLowerCase()
        .replace(/_/g, "-")}`,
      title: known?.message ?? "AI Assistant operation failed",
      status,
      code,
      retryable: known?.retryable ?? false,
      ...(known?.retryAfterSeconds
        ? { retryAfterSeconds: known.retryAfterSeconds }
        : {}),
      ...(correlationId ? { correlationId } : {}),
    });
};

const sseData = (event: AssistantProductStreamEvent): {
  name: AssistantProductStreamEvent["type"];
  data: string;
} => {
  const { type, ...data } = event;
  return { name: type, data: JSON.stringify(data) };
};

export const createPlatformAssistantController = (dependencies?: {
  application?: AssistantApplication;
  streamingApplication?: AssistantStreamingApplication;
  limiter?: AssistantOperationalLimiter;
  heartbeatMs?: () => number;
}) => {
  const application =
    dependencies?.application ?? platformAssistantApplication;
  const streamingApplication =
    dependencies?.streamingApplication ??
    platformAssistantStreamingApplication;
  const limiter = dependencies?.limiter ?? assistantOperationalLimiter;
  const heartbeatMs =
    dependencies?.heartbeatMs ?? (() => assistantRuntimeConfig().heartbeatMs);

  return {
    async listThreads(req: AuthRequest, res: Response) {
      try {
        const ctx = context(req);
        res.json({
          data: await application.listThreads(ctx, {
            limit: req.query.limit,
            updatedBefore: cursorDate(req.query.cursor),
          }),
        });
      } catch (error) {
        writePlatformAssistantProblem(res, error);
      }
    },

    async createThread(req: AuthRequest, res: Response) {
      try {
        requireJson(req);
        const result = await application.createThread(
          context(req),
          req.body,
          idempotencyKey(req),
        );
        res.status(result.created ? 201 : 200).json({ data: result });
      } catch (error) {
        writePlatformAssistantProblem(res, error);
      }
    },

    async getThread(req: AuthRequest, res: Response) {
      try {
        res.json({
          data: await application.getThread(context(req), {
            threadId: req.params.threadId,
            messageLimit: req.query.limit,
            beforeOrdinal: req.query.beforeOrdinal,
          }),
        });
      } catch (error) {
        writePlatformAssistantProblem(res, error);
      }
    },

    async patchThread(req: AuthRequest, res: Response) {
      try {
        requireJson(req);
        if (
          !req.body ||
          typeof req.body !== "object" ||
          (req.body as Record<string, unknown>).status !== "archived"
        ) {
          throw new PlatformAssistantError(
            "INVALID_ASSISTANT_THREAD_UPDATE",
            "Only archiving is supported for assistant conversations.",
            422,
          );
        }
        res.json({
          data: await application.archiveThread(
            context(req),
            req.params.threadId,
          ),
        });
      } catch (error) {
        writePlatformAssistantProblem(res, error);
      }
    },

    async streamMessage(req: AuthRequest, res: Response) {
      let lease: AssistantLimitLeaseLike | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let streamStarted = false;
      let terminalSent = false;
      let assistantMessageId = "";
      const abortController = new AbortController();
      let ctx: PlatformAssistantContext | null = null;

      const beginStream = () => {
        if (streamStarted) return;
        streamStarted = true;
        res.status(200).set({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders?.();
        heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n");
        }, heartbeatMs());
      };

      const emit = async (event: AssistantProductStreamEvent) => {
        if (res.destroyed || res.writableEnded) return;
        beginStream();
        if (event.type === "message.accepted") {
          assistantMessageId = event.assistantMessageId;
        }
        if (
          event.type === "response.completed" ||
          event.type === "response.failed"
        ) {
          terminalSent = true;
        }
        const encoded = sseData(event);
        res.write(`event: ${encoded.name}\ndata: ${encoded.data}\n\n`);
      };

      const disconnect = () => {
        if (!res.writableEnded) abortController.abort();
      };
      res.once("close", disconnect);

      try {
        requireJson(req);
        ctx = context(req);
        // Validate before counting the request or committing SSE headers.
        parseAssistantThreadId(req.params.threadId);
        parseAssistantMessageInput(req.body);
        const key = idempotencyKey(req);
        const responseKey = responseIdempotencyKey(req);
        lease = await limiter.acquire(ctx);
        await streamingApplication.streamGuidance(ctx, {
          threadId: req.params.threadId,
          body: req.body,
          idempotencyKey: key,
          responseIdempotencyKey: responseKey,
          signal: abortController.signal,
          emit,
        });
      } catch (error) {
        if (!streamStarted) {
          writePlatformAssistantProblem(res, error, ctx?.correlationId);
        } else if (
          !terminalSent &&
          !res.destroyed &&
          !res.writableEnded
        ) {
          const known =
            error instanceof PlatformAssistantError ? error : null;
          await emit({
            type: "response.failed",
            version: 1,
            assistantMessageId,
            code: known?.code || "ASSISTANT_PROVIDER_FAILED",
            message:
              known?.message ||
              "The assistant could not complete the response.",
            retryable: known?.retryable ?? false,
            ...(known?.retryAfterSeconds
              ? { retryAfterSeconds: known.retryAfterSeconds }
              : {}),
            correlationId:
              ctx?.correlationId ||
              String(res.getHeader("X-Correlation-ID") || ""),
          });
        }
      } finally {
        res.removeListener("close", disconnect);
        if (heartbeat) clearInterval(heartbeat);
        await lease?.release();
        if (streamStarted && !res.destroyed && !res.writableEnded) res.end();
      }
    },
  };
};

type AssistantLimitLeaseLike = {
  release(): Promise<void>;
};

const controller = createPlatformAssistantController();

export const listAssistantThreads = controller.listThreads;
export const createAssistantThread = controller.createThread;
export const getAssistantThread = controller.getThread;
export const patchAssistantThread = controller.patchThread;
export const streamAssistantMessage = controller.streamMessage;

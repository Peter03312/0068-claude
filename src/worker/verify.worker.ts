// Worker：主线程提交 verify 任务（含指纹）。
// 快速编辑时：
//   - 新 verify 到达会取消正在执行的旧任务（协作式 AbortToken），并清掉排队的更旧任务；
//   - 迟到结果带自己的指纹回传，主线程只采用最新指纹（双重保险：迟到结果不得覆盖新指纹）。

import type { Project } from '../domain/types';
import { verifyProject } from '../domain/verifier';
import { VerificationAborted } from '../domain/models';
import type { AbortToken } from '../domain/models';
import type { VerificationReport } from '../domain/verifier';

export interface VerifyRequest {
  type: 'verify';
  fingerprint: string;
  project: Project;
}
export interface CancelRequest {
  type: 'cancel';
  fingerprint: string;
}
export type WorkerRequest = VerifyRequest | CancelRequest;

export interface VerifyResponse {
  type: 'report';
  fingerprint: string;
  report: VerificationReport;
}
export interface CancelledResponse {
  type: 'cancelled';
  fingerprint: string;
}
export type WorkerResponse = VerifyResponse | CancelledResponse;

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

const pending: VerifyRequest[] = [];
let running: { fingerprint: string; token: AbortToken } | null = null;
let loopActive = false;

function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

function cancelByFingerprint(fp: string): boolean {
  let hit = false;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (pending[i].fingerprint === fp) {
      pending.splice(i, 1);
      post({ type: 'cancelled', fingerprint: fp });
      hit = true;
    }
  }
  if (running && running.fingerprint === fp) {
    running.token.cancelled = true;
    hit = true;
  }
  return hit;
}

/** 新任务到达：作废所有更早（仍排队或正在跑）的任务 */
function supersedeAllButNewest(req: VerifyRequest): void {
  while (pending.length > 0) {
    const old = pending.shift()!;
    post({ type: 'cancelled', fingerprint: old.fingerprint });
  }
  if (running && running.fingerprint !== req.fingerprint) {
    running.token.cancelled = true;
  }
  pending.push(req);
}

async function runLoop(): Promise<void> {
  if (loopActive) return;
  loopActive = true;
  try {
    while (pending.length > 0) {
      const task = pending.shift()!;
      const token: AbortToken = { cancelled: false };
      running = { fingerprint: task.fingerprint, token };
      try {
        const report = await verifyProject(task.project, token);
        if (token.cancelled) {
          post({ type: 'cancelled', fingerprint: task.fingerprint });
        } else {
          post({ type: 'report', fingerprint: task.fingerprint, report });
        }
      } catch (err) {
        if (err instanceof VerificationAborted || token.cancelled) {
          post({ type: 'cancelled', fingerprint: task.fingerprint });
        } else {
          throw err;
        }
      } finally {
        running = null;
      }
    }
  } finally {
    loopActive = false;
  }
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'verify') {
    supersedeAllButNewest(msg);
    void runLoop();
  } else if (msg.type === 'cancel') {
    cancelByFingerprint(msg.fingerprint);
  }
};

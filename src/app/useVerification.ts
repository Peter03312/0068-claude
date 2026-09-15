import { useEffect, useRef, useState } from 'react';
import type { Project } from '../domain/types';
import type { VerificationReport } from '../domain/verifier';
import type { WorkerResponse, VerifyRequest } from '../worker/verify.worker';
import { fingerprint } from './fingerprint';
import VerifyWorker from '../worker/verify.worker.ts?worker';

export type VerifyStatus = 'idle' | 'checking' | 'done';

export interface VerificationState {
  status: VerifyStatus;
  report: VerificationReport | null;
  /** 当前结果对应的指纹；与最新编辑指纹不同时说明结果已过期 */
  resultFingerprint: string | null;
  latestFingerprint: string | null;
}

const DEBOUNCE_MS = 180;

// 模块级单例 worker：StrictMode 双挂载与整个会话共用一个。
let sharedWorker: Worker | null = null;
function getWorker(): Worker {
  if (!sharedWorker) sharedWorker = new VerifyWorker();
  return sharedWorker;
}

export function useVerification(project: Project): VerificationState {
  const [state, setState] = useState<VerificationState>({
    status: 'idle',
    report: null,
    resultFingerprint: null,
    latestFingerprint: null
  });
  const workerRef = useRef<Worker>(getWorker());
  const worker = workerRef.current;
  const timerRef = useRef<number | null>(null);
  const latestFpRef = useRef<string | null>(null);
  // 仅订阅一次：worker 是单例，handler 通过 ref 读最新指纹，避免重复绑定
  useEffect(() => {
    const onMessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'report') {
        // 迟到结果不得覆盖新指纹
        if (msg.fingerprint !== latestFpRef.current) return;
        setState({
          status: 'done',
          report: msg.report,
          resultFingerprint: msg.fingerprint,
          latestFingerprint: msg.fingerprint
        });
      }
      // cancelled：旧任务作废，不改动当前 checking 状态（新结果随后会到）
    };
    worker.addEventListener('message', onMessage);
    return () => worker.removeEventListener('message', onMessage);
  }, [worker]);

  useEffect(() => {
    const fp = fingerprint(project);
    latestFpRef.current = fp;
    setState((s) =>
      s.resultFingerprint === fp && s.report
        ? { ...s, status: 'done', latestFingerprint: fp }
        : { ...s, status: 'checking', latestFingerprint: fp }
    );

    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      // worker 内部会作废旧任务；这里只需投递最新任务
      const req: VerifyRequest = { type: 'verify', fingerprint: fp, project };
      worker.postMessage(req);
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [project, worker]);

  return state;
}

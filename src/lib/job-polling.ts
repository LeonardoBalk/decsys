export type JobSnapshot<Result = unknown> = {
  job_id: string;
  status: "running" | "done" | "error";
  phase: string;
  progress: number;
  result: Result | null;
  error: string | null;
  error_status: number | null;
};

export type StartedJob = Pick<JobSnapshot, "job_id" | "status" | "phase" | "progress">;

type PollOptions<Result> = {
  intervalMs?: number;
  maxMs?: number;
  onProgress?: (phase: string, progress: number) => void;
  fetchJob?: (jobId: string) => Promise<Response>;
  wait?: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
  parseResult?: (value: unknown) => Result;
};

export class JobFailedError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultFetchJob = (jobId: string) => fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });

export async function pollJob<Result>(jobId: string, options: PollOptions<Result> = {}): Promise<Result> {
  const { intervalMs = 1500, maxMs = 30 * 60_000, onProgress, fetchJob = defaultFetchJob, wait = defaultWait, isCancelled } = options;
  const startedAt = Date.now();
  let consecutiveFailures = 0;
  while (Date.now() - startedAt < maxMs) {
    if (isCancelled?.()) throw new JobFailedError("Acompanhamento interrompido.", null);
    try {
      const response = await fetchJob(jobId);
      if (response.status === 404) throw new JobFailedError("O serviço não encontrou mais esta tarefa (pode ter reiniciado). Confira em Importações salvas se os valores foram gravados.", 404);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json() as JobSnapshot<Result>;
      consecutiveFailures = 0;
      onProgress?.(snapshot.phase, snapshot.progress);
      if (snapshot.status === "done") return (options.parseResult ? options.parseResult(snapshot.result) : snapshot.result) as Result;
      if (snapshot.status === "error") throw new JobFailedError(snapshot.error ?? "A tarefa falhou.", snapshot.error_status);
    } catch (pollError) {
      if (pollError instanceof JobFailedError) throw pollError;
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) throw new JobFailedError("Perdemos o contato com o serviço de tratamento. A gravação pode ter continuado: confira em Importações salvas antes de tentar de novo.", null);
    }
    await wait(intervalMs);
  }
  throw new JobFailedError("A tarefa está demorando mais que o esperado. Confira em Importações salvas antes de tentar de novo.", null);
}

export async function runInBackground<Result>(url: string, body: unknown, options: PollOptions<Result> & { fallbackMessage: string; errorMessage: (response: Response) => Promise<string> }): Promise<Result> {
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(`${url}${separator}background=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new JobFailedError(await options.errorMessage(response), response.status);
  const payload = await response.json() as StartedJob | Result;
  if (response.status === 202 && typeof payload === "object" && payload !== null && "job_id" in payload) return pollJob<Result>((payload as StartedJob).job_id, options);
  return payload as Result;
}

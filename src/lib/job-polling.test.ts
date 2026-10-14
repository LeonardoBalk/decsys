import { describe, expect, it, vi } from "vitest";
import { JobFailedError, pollJob } from "./job-polling";

const snapshot = (overrides: Record<string, unknown>) => ({ job_id: "j1", status: "running", phase: "Lendo", progress: 0.1, result: null, error: null, error_status: null, ...overrides });
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const noWait = () => Promise.resolve();

describe("acompanhamento de tarefas em segundo plano", () => {
  it("repassa o andamento e devolve o resultado quando termina", async () => {
    const answers = [snapshot({}), snapshot({ phase: "Gravando", progress: 0.7 }), snapshot({ status: "done", progress: 1, result: { approved: 12 } })];
    const progress: [string, number][] = [];
    const result = await pollJob<{ approved: number }>("j1", { fetchJob: () => reply(answers.shift()), wait: noWait, onProgress: (phase, value) => progress.push([phase, value]) });
    expect(result).toEqual({ approved: 12 });
    expect(progress).toEqual([["Lendo", 0.1], ["Gravando", 0.7], ["Lendo", 1]]);
  });

  it("falha com a mensagem e o status do servidor", async () => {
    const poll = pollJob("j1", { fetchJob: () => reply(snapshot({ status: "error", error: "Valor inválido.", error_status: 422 })), wait: noWait });
    await expect(poll).rejects.toMatchObject({ message: "Valor inválido.", status: 422 });
  });

  it("explica o que fazer quando a tarefa some (serviço reiniciou)", async () => {
    await expect(pollJob("j1", { fetchJob: () => reply({ detail: "x" }, 404), wait: noWait })).rejects.toThrow(/Importações salvas/);
  });

  it("tolera falhas passageiras de rede mas desiste depois de cinco seguidas", async () => {
    let calls = 0;
    const flaky = () => { calls += 1; return calls <= 2 ? Promise.reject(new TypeError("rede")) : reply(snapshot({ status: "done", result: "ok" })); };
    await expect(pollJob("j1", { fetchJob: flaky, wait: noWait })).resolves.toBe("ok");
    const down = vi.fn(() => Promise.reject(new TypeError("rede")));
    await expect(pollJob("j1", { fetchJob: down, wait: noWait })).rejects.toBeInstanceOf(JobFailedError);
    expect(down).toHaveBeenCalledTimes(5);
  });

  it("para quando o acompanhamento é cancelado", async () => {
    let cancelled = false;
    const poll = pollJob("j1", { fetchJob: () => { cancelled = true; return reply(snapshot({})); }, wait: noWait, isCancelled: () => cancelled });
    await expect(poll).rejects.toThrow(/interrompido/);
  });
});

"""Tarefas longas em segundo plano (aprovações grandes), consultadas por polling.

O estado fica em memória do processo: serve para acompanhar o andamento enquanto o serviço está de pé.
Se o processo reiniciar, o que já foi gravado no banco continua lá; só o acompanhamento se perde.
"""
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import APIRouter, HTTPException

router = APIRouter()
job_retention_seconds = 60 * 60
maximum_jobs = 200


@dataclass
class Job:
    id: str
    kind: str
    import_id: str | None
    status: str = "running"  # running | done | error
    phase: str = "Iniciando"
    progress: float = 0.0
    result: dict[str, Any] | None = None
    error: str | None = None
    error_status: int | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def report(self, phase: str, progress: float | None = None) -> None:
        self.phase = phase
        if progress is not None:
            self.progress = max(0.0, min(1.0, progress))

    def public(self) -> dict[str, Any]:
        return {"job_id": self.id, "kind": self.kind, "import_id": self.import_id, "status": self.status, "phase": self.phase, "progress": round(self.progress, 3), "result": self.result, "error": self.error, "error_status": self.error_status, "elapsed_seconds": round((self.finished_at or time.time()) - self.created_at, 1)}


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()


def forget_old_jobs() -> None:
    cutoff = time.time() - job_retention_seconds
    for job_id in [job_id for job_id, job in jobs.items() if job.finished_at and job.finished_at < cutoff]:
        del jobs[job_id]
    while len(jobs) > maximum_jobs:
        del jobs[min(jobs, key=lambda job_id: jobs[job_id].created_at)]


def start_job(kind: str, import_id: str | None, work: Callable[[Job], dict[str, Any]]) -> Job:
    job = Job(id=uuid.uuid4().hex, kind=kind, import_id=import_id)
    with jobs_lock:
        forget_old_jobs()
        jobs[job.id] = job

    def run() -> None:
        try:
            job.result = work(job)
            job.status, job.progress, job.phase = "done", 1.0, "Concluído"
        except HTTPException as http_error:
            job.status, job.error, job.error_status = "error", str(http_error.detail), http_error.status_code
        except Exception as unexpected_error:  # noqa: BLE001 - qualquer falha precisa chegar a quem acompanha
            job.status, job.error, job.error_status = "error", f"Falha inesperada: {unexpected_error}", 500
        finally:
            job.finished_at = time.time()

    threading.Thread(target=run, daemon=True, name=f"job-{kind}-{job.id[:8]}").start()
    return job


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Tarefa não encontrada. Se o serviço reiniciou, confira em Importações salvas se os valores foram gravados.")
    return job.public()

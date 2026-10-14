import httpx
import json
import os
import time
from openai import OpenAI
from typing import Any

from .config import ai_assessment_timeout


ai_unavailable_until = 0.0

def assessment_schema() -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "properties": {"summary": {"type": "string"}, "municipality_field": {"type": ["string", "null"]}, "year_field": {"type": ["string", "null"]}, "measure_field": {"type": ["string", "null"]}, "risks": {"type": "array", "items": {"type": "string"}}}, "required": ["summary", "municipality_field", "year_field", "measure_field", "risks"]}

def assessment_prompt(source_profile: dict[str, Any]) -> str:
    return "Avalie esta fonte de dados urbanos. Não invente significados de campos. Identifique somente o que estiver sustentado pelas colunas e pela amostra. A resposta será revisada por uma pessoa antes de qualquer importação. Responda somente no objeto JSON solicitado, sem encapsular em outro campo. Fonte: " + json.dumps(source_profile, ensure_ascii=False, default=str)

def assess_with_openai(source_profile: dict[str, Any]) -> dict[str, Any]:
    response = OpenAI(api_key=os.environ["OPENAI_API_KEY"]).responses.create(model=os.getenv("OPENAI_MODEL", "gpt-5-mini"), input=assessment_prompt(source_profile), text={"format": {"type": "json_schema", "name": "source_assessment", "strict": True, "schema": assessment_schema()}})
    return {"status": "available", "provider": "openai", **json.loads(response.output_text)}

def assess_with_gemini(source_profile: dict[str, Any]) -> dict[str, Any]:
    gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    gemini_response = httpx.post(f"https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent", params={"key": os.environ["GEMINI_API_KEY"]}, json={"contents": [{"role": "user", "parts": [{"text": assessment_prompt(source_profile)}]}], "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": assessment_schema(), "temperature": 0.1}}, timeout=ai_assessment_timeout)
    gemini_response.raise_for_status()
    response_text = gemini_response.json()["candidates"][0]["content"]["parts"][0]["text"]
    return {"status": "available", "provider": "gemini", **json.loads(response_text)}

def assess_source(source_profile: dict[str, Any]) -> dict[str, Any]:
    global ai_unavailable_until
    provider = os.getenv("AI_PROVIDER", "gemini").lower()
    has_provider_key = (provider == "gemini" and os.getenv("GEMINI_API_KEY")) or (provider == "openai" and os.getenv("OPENAI_API_KEY"))
    if not has_provider_key:
        return {"status": "not_configured", "summary": f"A leitura estrutural foi concluída. Configure a chave do provedor {provider} para receber a avaliação do agente."}
    if time.monotonic() < ai_unavailable_until:
        return {"status": "unavailable", "summary": "A estrutura foi lida. A avaliação por IA está temporariamente indisponível, então o Decsys seguirá com sugestões automáticas."}
    try:
        if provider == "openai":
            return assess_with_openai(source_profile)
        if provider == "gemini":
            return assess_with_gemini(source_profile)
        return {"status": "not_configured", "summary": "O provedor de IA configurado não é suportado."}
    except Exception:
        ai_unavailable_until = time.monotonic() + 300
        return {"status": "unavailable", "summary": "A estrutura foi lida, mas a avaliação do agente não ficou disponível para esta fonte."}

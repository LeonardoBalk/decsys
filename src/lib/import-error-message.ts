const validationFieldNames: Record<string, string> = {
  code: "código interno",
  name: "nome",
  dimension: "dimensão",
  definition: "definição",
  unit: "unidade",
  expected_frequency: "periodicidade",
  calculation_type: "forma de cálculo",
  calculation_multiplier: "multiplicador",
  iiu_enabled: "opção do IIU",
  iiu_dimension_code: "dimensão do IIU",
  score_direction: "interpretação do score",
  checklist_max: "pontuação máxima",
};

export async function importErrorMessage(response: Response, fallbackMessage: string) {
  try {
    const responsePayload: unknown = await response.json();
    if (responsePayload && typeof responsePayload === "object") {
      const payloadFields = responsePayload as { detail?: unknown; message?: unknown };
      const serverMessage = typeof payloadFields.detail === "string" ? payloadFields.detail : payloadFields.message;
      if (typeof serverMessage === "string" && serverMessage.trim()) return serverMessage;
      if (Array.isArray(payloadFields.detail)) {
        const invalidFields = new Set(payloadFields.detail.flatMap((validationIssue: unknown) => {
          if (!validationIssue || typeof validationIssue !== "object") return [];
          const location = (validationIssue as { loc?: unknown }).loc;
          if (!Array.isArray(location)) return [];
          const fieldName = location.map(String).reverse().find((locationName) => validationFieldNames[locationName]);
          return fieldName ? [validationFieldNames[fieldName]] : [];
        }));
        if (invalidFields.size) return `Confira estes campos: ${[...invalidFields].join(", ")}.`;
      }
    }
  } catch {}

  if (response.status === 413) return "Este arquivo é grande demais para enviar de uma vez. Divida a planilha em arquivos menores e tente novamente.";
  if (response.status === 429) return "O serviço está recebendo muitas solicitações. Aguarde um pouco e tente novamente.";
  if (response.status >= 500) return "O serviço não conseguiu concluir esta etapa. Seus dados originais continuam no arquivo; tente novamente em alguns instantes.";
  return fallbackMessage;
}

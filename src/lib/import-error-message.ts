export async function importErrorMessage(response: Response, fallbackMessage: string) {
  try {
    const responsePayload: unknown = await response.json();
    if (responsePayload && typeof responsePayload === "object") {
      const payloadFields = responsePayload as { detail?: unknown; message?: unknown };
      const serverMessage = typeof payloadFields.detail === "string" ? payloadFields.detail : payloadFields.message;
      if (typeof serverMessage === "string" && serverMessage.trim()) return serverMessage;
    }
  } catch {}

  if (response.status === 413) return "Este arquivo é grande demais para enviar de uma vez. Divida a planilha em arquivos menores e tente novamente.";
  if (response.status === 429) return "O serviço está recebendo muitas solicitações. Aguarde um pouco e tente novamente.";
  if (response.status >= 500) return "O serviço não conseguiu concluir esta etapa. Seus dados originais continuam no arquivo; tente novamente em alguns instantes.";
  return fallbackMessage;
}

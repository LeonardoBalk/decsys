let unsavedChangesMessage: string | null = null;

export function setUnsavedChanges(message: string | null) {
  unsavedChangesMessage = message;
}

export function confirmLeavingUnsavedWork() {
  return unsavedChangesMessage === null || window.confirm(unsavedChangesMessage);
}

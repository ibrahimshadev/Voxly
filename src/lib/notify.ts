import { toast } from 'solid-sonner';

const DEFAULT_TOAST_DURATION_MS = 2200;
const DEFAULT_ERROR_TOAST_DURATION_MS = 3500;

const resolveErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }
  return fallback;
};

export const notifySuccess = (message: string) => {
  toast.success(message, { duration: DEFAULT_TOAST_DURATION_MS });
};

export const notifyInfo = (message: string) => {
  toast.info(message, { duration: DEFAULT_TOAST_DURATION_MS });
};

export const notifyError = (error: unknown, fallback = 'Something went wrong.') => {
  toast.error(resolveErrorMessage(error, fallback), { duration: DEFAULT_ERROR_TOAST_DURATION_MS });
};

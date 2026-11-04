interface Props {
  message: string;
  onRetry?: () => void;
}

export function ErrorBanner({ message, onRetry }: Props) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onRetry !== undefined && (
        <button type="button" className="button-secondary" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}

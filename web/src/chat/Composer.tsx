import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { readImage as defaultReadImage } from "./images";
import type { ImageAttachment } from "./state";

interface Props {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string, images: ImageAttachment[]) => void;
  onStop: () => void;
  /** Подмена в тестах (в jsdom нет createImageBitmap). */
  readImage?: (file: File) => Promise<ImageAttachment>;
}

function imageFiles(files: Iterable<File>): File[] {
  return [...files].filter((f) => f.type.startsWith("image/"));
}

export function Composer({
  disabled,
  streaming,
  onSend,
  onStop,
  readImage = defaultReadImage,
}: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  // зеркало текста и картинок: второй Enter в том же тике не должен отправить повторно
  const textRef = useRef("");
  const imagesRef = useRef<ImageAttachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const updateText = (value: string) => {
    textRef.current = value;
    setText(value);
  };
  const updateImages = (value: ImageAttachment[]) => {
    imagesRef.current = value;
    setImages(value);
  };

  const addFiles = (files: File[]) => {
    setImageError(null);
    for (const file of files) {
      readImage(file).then(
        (image) => {
          updateImages([...imagesRef.current, image]);
        },
        (error: unknown) => {
          setImageError(error instanceof Error ? error.message : String(error));
        },
      );
    }
  };

  const submit = () => {
    const value = textRef.current.trim();
    const attached = imagesRef.current;
    if (disabled || streaming || (value === "" && attached.length === 0)) return;
    updateText("");
    updateImages([]);
    onSend(value, attached);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    // текст вставляется как обычно — перехватываем только картинки
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = imageFiles(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  return (
    <div
      className="composer card"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={onDrop}
    >
      {images.length > 0 && (
        <ul className="thumbs">
          {images.map((image, index) => (
            <li key={`${image.name}-${String(index)}`}>
              <img src={image.dataUrl} alt={image.name} />
              <button
                type="button"
                className="thumb-remove"
                aria-label={`Убрать ${image.name}`}
                onClick={() => {
                  updateImages(imagesRef.current.filter((_, i) => i !== index));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {imageError !== null && <p className="composer-error">{imageError}</p>}
      <textarea
        aria-label="Сообщение"
        placeholder="Сообщение… (Enter — отправить, Shift+Enter — новая строка)"
        rows={3}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          updateText(event.target.value);
        }}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-actions">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="visually-hidden"
          aria-label="Картинка"
          onChange={(event) => {
            addFiles(imageFiles(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="button-secondary"
          disabled={disabled}
          onClick={() => {
            fileRef.current?.click();
          }}
        >
          Прикрепить картинку
        </button>
        {streaming ? (
          <button type="button" className="button-danger" onClick={onStop}>
            Стоп
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || (text.trim() === "" && images.length === 0)}
            onClick={submit}
          >
            Отправить
          </button>
        )}
      </div>
    </div>
  );
}

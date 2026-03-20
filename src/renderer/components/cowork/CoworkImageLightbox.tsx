import React, { useEffect } from 'react';

interface CoworkImageLightboxProps {
  imageSrc: string | null;
  imageAlt?: string;
  onClose: () => void;
}

const CoworkImageLightbox: React.FC<CoworkImageLightboxProps> = ({
  imageSrc,
  imageAlt = 'Preview',
  onClose,
}) => {
  useEffect(() => {
    if (!imageSrc) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [imageSrc, onClose]);

  if (!imageSrc) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-pointer"
      onClick={onClose}
    >
      <img
        src={imageSrc}
        alt={imageAlt}
        className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
};

export default CoworkImageLightbox;

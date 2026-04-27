import React, { useState, useRef, useCallback } from 'react';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  position?: 'top' | 'bottom';
  delay?: number;
  maxWidth?: string;
  disabled?: boolean;
}

const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  className = '',
  position = 'bottom',
  delay = 400,
  disabled = false,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const showTooltip = useCallback(() => {
    if (disabled) return;
    timeoutRef.current = setTimeout(() => {
      setIsVisible(true);
    }, delay);
  }, [delay, disabled]);

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  }, []);

  return (
    <div
      className={`relative ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
    >
      {children}
      {isVisible && content && (
        <div
          className={`absolute z-[100] px-2 py-1 text-xs rounded shadow-lg
            bg-gray-800 text-white
            pointer-events-none whitespace-pre-wrap
            left-0 right-0
            ${position === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'}`}
        >
          {content}
        </div>
      )}
    </div>
  );
};

export default Tooltip;
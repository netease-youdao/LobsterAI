import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';

interface EmojiCategory {
  label: string;
  labelEn: string;
  emojis: string[];
}

const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    label: '机器人 & 科技',
    labelEn: 'Robots & Tech',
    emojis: [
      '🤖', '🦾', '🧠', '💡', '⚡', '🔮', '🖥️', '💻', '🛠️', '⚙️',
      '🔧', '🔩', '🧲', '📡', '🛰️', '🔋', '💾', '📱', '🖨️', '🖱️',
      '⌨️', '🖲️', '📲', '🔌', '💿', '📀', '🎮', '🕹️', '🤳', '📷',
    ],
  },
  {
    label: '人物 & 职业',
    labelEn: 'People & Roles',
    emojis: [
      '🧑‍💻', '👨‍🔬', '🧑‍🎨', '🧙', '🕵️', '👩‍🚀', '🧑‍🏫', '🦸', '🧚', '🧑‍⚕️',
      '👨‍🍳', '🧑‍🔧', '👨‍🎤', '🧑‍🚒', '👮', '💂', '🧑‍⚖️', '👷', '🧑‍🌾', '🧑‍🎓',
      '🧛', '🧟', '🧞', '🧜', '🧝', '🥷', '🤴', '👸', '🤶', '🎅',
    ],
  },
  {
    label: '动物',
    labelEn: 'Animals',
    emojis: [
      '🦞', '🐙', '🦊', '🐺', '🦁', '🐉', '🦅', '🦉', '🐬', '🦋',
      '🐯', '🐻', '🐼', '🐨', '🦄', '🐲', '🦕', '🦖', '🦈', '🐊',
      '🐸', '🦜', '🦚', '🦩', '🦢', '🦦', '🦥', '🐿️', '🦔', '🐇',
      '🦝', '🦨', '🐓', '🦃', '🦤', '🪶', '🐦', '🕊️', '🦭', '🦬',
    ],
  },
  {
    label: '物品 & 工具',
    labelEn: 'Objects & Tools',
    emojis: [
      '📚', '📝', '🔍', '🎯', '🚀', '🌟', '💎', '🏆', '🎭', '🎨',
      '🗝️', '🔑', '🗡️', '⚔️', '🛡️', '🏹', '🪄', '🎩', '🧸', '🪆',
      '🎸', '🎹', '🥁', '🎺', '🎻', '🪕', '🎷', '🪗', '🎤', '🎧',
      '📜', '📖', '🗒️', '📐', '📏', '✏️', '🖊️', '🖋️', '🖌️', '🖍️',
    ],
  },
  {
    label: '食物 & 饮料',
    labelEn: 'Food & Drink',
    emojis: [
      '🍎', '🍊', '🍋', '🍇', '🍓', '🫐', '🍒', '🍑', '🥭', '🍍',
      '🥥', '🥝', '🍅', '🥑', '🌽', '🍄', '🧅', '🧄', '🥕', '🫘',
      '🍕', '🍔', '🌮', '🌯', '🍜', '🍱', '🍣', '🍩', '🍰', '🎂',
      '☕', '🍵', '🧋', '🍺', '🥂', '🍾', '🧃', '🥤', '🧊', '🍫',
    ],
  },
  {
    label: '自然 & 天气',
    labelEn: 'Nature & Weather',
    emojis: [
      '🌍', '🌙', '☀️', '⭐', '🌈', '🌊', '🔥', '❄️', '⛈️', '🌪️',
      '🌸', '🌺', '🌻', '🌹', '🌷', '🍀', '🌿', '🍃', '🍂', '🍁',
      '🌴', '🌵', '🎋', '🎍', '🪨', '🪵', '🌾', '💐', '🪷', '🌱',
      '🌝', '🌛', '🌜', '🌚', '🌕', '🌖', '🌗', '🌘', '🌑', '🌒',
    ],
  },
  {
    label: '旅行 & 地点',
    labelEn: 'Travel & Places',
    emojis: [
      '🚗', '🚕', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻',
      '🚚', '🚛', '🚜', '🏍️', '🛵', '🚲', '✈️', '🛸', '🚁', '⛵',
      '🚢', '🛥️', '🚤', '⛴️', '🛶', '🏠', '🏰', '🗼', '🗽', '🏔️',
      '⛰️', '🌋', '🗻', '🏕️', '🏖️', '🏜️', '🏝️', '🏞️', '🌆', '🌃',
    ],
  },
  {
    label: '活动 & 运动',
    labelEn: 'Activities & Sports',
    emojis: [
      '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
      '🏓', '����', '🏒', '🥍', '🏏', '🪃', '🥅', '⛳', '🏹', '🎣',
      '🤿', '🎿', '🛷', '🥌', '🛹', '🛼', '🪂', '🏋️', '🤸', '⛹️',
      '🤺', '🏊', '🧗', '🚵', '🏇', '🏄', '🤾', '🤼', '🎽', '🥊',
    ],
  },
  {
    label: '符号 & 标志',
    labelEn: 'Symbols',
    emojis: [
      '✨', '💫', '🎪', '🎲', '♟️', '🔬', '🧪', '🌐', '💥', '🎆',
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '♾️', '✅', '❎', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫',
      '⬛', '⬜', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🔶', '🔷',
    ],
  },
];

interface EmojiPickerProps {
  value: string;
  onChange: (value: string) => void;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const EmojiPicker: React.FC<EmojiPickerProps> = ({
  value,
  onChange,
  isOpen: controlledIsOpen,
  onOpenChange,
}) => {
  const [uncontrolledIsOpen, setUncontrolledIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lang = i18nService.getLanguage();
  const isOpen = controlledIsOpen ?? uncontrolledIsOpen;

  const setIsOpen = useCallback((open: boolean) => {
    if (controlledIsOpen === undefined) {
      setUncontrolledIsOpen(open);
    }
    onOpenChange?.(open);
  }, [controlledIsOpen, onOpenChange]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, setIsOpen]);

  const handleSelect = (emoji: string) => {
    onChange(emoji);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        title={i18nService.t('emojiPickerTitle') || 'Choose icon'}
        className={`w-12 h-[38px] flex items-center justify-center rounded-lg border text-lg transition-colors
          dark:border-claude-darkBorder border-claude-border
          hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover
          ${isOpen ? 'ring-2 ring-claude-accent' : ''}
        `}
      >
        <span>{value || '🤖'}</span>
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div
          className="absolute left-0 top-full mt-1 z-50 w-80 rounded-xl shadow-xl
            bg-white dark:bg-claude-darkSurface
            border dark:border-claude-darkBorder border-claude-border p-3
            flex flex-col"
          style={{ maxHeight: '420px' }}
        >
          {/* Manual input */}
          <div className="shrink-0 mb-2">
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
              {i18nService.t('emojiCustomInput') || 'Or type an emoji'}
            </label>
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="🤖"
              maxLength={4}
              className="w-full px-3 py-1.5 text-sm text-center rounded-lg border
                dark:border-claude-darkBorder border-claude-border
                bg-transparent dark:text-claude-darkText text-claude-text"
              autoFocus
            />
          </div>

          <div className="shrink-0 border-t dark:border-claude-darkBorder border-claude-border mb-2" />

          {/* All categories — vertically scrollable */}
          <div className="overflow-y-auto flex-1 min-h-0 pr-0.5">
            {EMOJI_CATEGORIES.map((cat, catIdx) => (
              <div key={catIdx} className="mb-3">
                {/* Category label */}
                <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1 px-0.5">
                  {lang === 'zh' ? cat.label : cat.labelEn}
                </div>
                {/* Emoji grid */}
                <div className="grid grid-cols-10 gap-0.5">
                  {cat.emojis.map((emoji) => (
                    <button
                      key={`${catIdx}-${emoji}`}
                      type="button"
                      onClick={() => handleSelect(emoji)}
                      title={emoji}
                      className={`w-7 h-7 flex items-center justify-center rounded-md text-base transition-colors
                        hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover
                        ${value === emoji ? 'bg-claude-accent/15 ring-1 ring-claude-accent' : ''}
                      `}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default EmojiPicker;

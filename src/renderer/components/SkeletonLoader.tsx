import React from 'react';

export function ChatSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full skeleton" />
          <div className="flex-1 space-y-2">
            <div className="h-4 skeleton w-3/4" />
            <div className="h-4 skeleton w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

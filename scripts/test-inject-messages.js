/**
 * 在 DevTools Console 中粘贴运行此脚本
 * 向当前 Cowork 会话注入 200 条模拟消息用于性能测试
 *
 * 使用方法:
 *   1. 先打开一个 Cowork 会话
 *   2. 打开 DevTools (Cmd+Shift+I)
 *   3. 粘贴此脚本到 Console 并回车
 */

(function injectTestMessages() {
  // Try multiple methods to find Redux store
  let store = null;

  // Method 1: window.__REDUX_STORE__ (if exposed)
  if (window.__REDUX_STORE__) {
    store = window.__REDUX_STORE__;
  }

  // Method 2: Walk React fiber tree
  if (!store) {
    const rootEl = document.getElementById('root');
    if (rootEl) {
      const fiberKey = Object.keys(rootEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (fiberKey) {
        let fiber = rootEl[fiberKey];
        while (fiber) {
          const s = fiber.memoizedProps?.store || fiber.stateNode?.store;
          if (s?.dispatch && s?.getState) {
            store = s;
            break;
          }
          fiber = fiber.return;
        }
      }
    }
  }

  // Method 3: Scan all DOM elements for React Provider
  if (!store) {
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!key) continue;
      let fiber = el[key];
      let depth = 0;
      while (fiber && depth < 50) {
        const s = fiber.memoizedProps?.store;
        if (s?.dispatch && s?.getState) {
          store = s;
          break;
        }
        fiber = fiber.return;
        depth++;
      }
      if (store) break;
    }
  }

  if (!store) {
    console.error('Cannot find Redux store. Try running this in the renderer process DevTools.');
    console.log('Tip: In Electron, use View > Toggle Developer Tools, or press Cmd+Option+I while the main window is focused.');
    return;
  }

  const state = store.getState();
  console.log('Found Redux store. State keys:', Object.keys(state));
  const sessionId = state.cowork?.currentSessionId;
  if (!sessionId) {
    console.error('No active cowork session. Please open a session first.');
    return;
  }

  console.log(`Injecting 200 messages into session: ${sessionId}`);

  const sampleContents = [
    '你好，请帮我分析一下这段代码的性能问题。',
    '当然可以。让我看看你的代码...\n\n```typescript\nfunction fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}\n```\n\n这个递归实现的时间复杂度是 O(2^n)，建议使用动态规划优化。',
    '能给个优化后的版本吗？',
    '好的，这是使用动态规划优化后的版本：\n\n```typescript\nfunction fibonacci(n: number): number {\n  if (n <= 1) return n;\n  let prev = 0, curr = 1;\n  for (let i = 2; i <= n; i++) {\n    [prev, curr] = [curr, prev + curr];\n  }\n  return curr;\n}\n```\n\n时间复杂度从 O(2^n) 降到了 O(n)，空间复杂度 O(1)。',
    '这个方案不错！还有别的优化思路吗？',
    '还可以使用**矩阵快速幂**，将时间复杂度进一步降到 O(log n)：\n\n$$\\begin{pmatrix} F(n+1) \\\\ F(n) \\end{pmatrix} = \\begin{pmatrix} 1 & 1 \\\\ 1 & 0 \\end{pmatrix}^n \\begin{pmatrix} 1 \\\\ 0 \\end{pmatrix}$$\n\n不过对于大多数应用场景，O(n) 的方案已经足够了。',
    '帮我写一个 React 组件，显示一个可以拖拽排序的列表。',
    '我来帮你实现。这里使用 `@dnd-kit/core` 库：\n\n```tsx\nimport { DndContext, closestCenter } from \'@dnd-kit/core\';\nimport { SortableContext, verticalListSortingStrategy } from \'@dnd-kit/sortable\';\n\nfunction SortableList({ items, onReorder }) {\n  return (\n    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>\n      <SortableContext items={items} strategy={verticalListSortingStrategy}>\n        {items.map(item => <SortableItem key={item.id} item={item} />)}\n      </SortableContext>\n    </DndContext>\n  );\n}\n```',
    '谢谢！能帮我看看为什么 TypeScript 报错了吗？',
    '请把报错信息发给我看看。',
    '```\nTS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.\n```',
    '这是类型不匹配的错误。你传入了一个字符串，但函数期望的是数字类型。可以使用 `parseInt()` 或 `Number()` 进行转换。',
    '这个项目的目录结构能帮我梳理一下吗？',
    '好的，我来看一下当前项目结构...\n\n```\nsrc/\n├── main/          # Electron 主进程\n├── renderer/      # React 渲染进程\n│   ├── components/\n│   ├── services/\n│   ├── store/\n│   └── types/\n└── shared/        # 共享类型和工具\n```',
    '帮我写一个单元测试。',
    '```typescript\nimport { describe, it, expect } from \'vitest\';\nimport { fibonacci } from \'./fibonacci\';\n\ndescribe(\'fibonacci\', () => {\n  it(\'should return 0 for n=0\', () => {\n    expect(fibonacci(0)).toBe(0);\n  });\n  it(\'should return 1 for n=1\', () => {\n    expect(fibonacci(1)).toBe(1);\n  });\n  it(\'should return 55 for n=10\', () => {\n    expect(fibonacci(10)).toBe(55);\n  });\n});\n```',
    '运行结果全部通过了 ✅',
    '太好了！测试覆盖了边界情况和正常情况，代码质量有保障。',
    '还有什么需要优化的地方吗？',
    '建议再加几个方面的测试：\n\n1. **负数输入** - 测试 `fibonacci(-1)` 的行为\n2. **大数输入** - 测试 `fibonacci(50)` 确保不会溢出\n3. **性能测试** - 确保大数计算在合理时间内完成',
    '好的，我加上这些测试用例。',
  ];

  const now = Date.now();
  const messages = [];

  for (let i = 0; i < 200; i++) {
    const isUser = i % 2 === 0;
    const contentIndex = i % sampleContents.length;
    messages.push({
      sessionId,
      message: {
        id: `test-msg-${i}-${Date.now()}`,
        type: isUser ? 'user' : 'assistant',
        content: sampleContents[contentIndex],
        timestamp: now - (200 - i) * 1000,
        metadata: isUser ? {} : { isFinal: true },
      },
    });
  }

  // Batch dispatch
  const batchSize = 10;
  let injected = 0;

  function injectBatch() {
    const batch = messages.slice(injected, injected + batchSize);
    batch.forEach(msg => {
      store.dispatch({ type: 'cowork/addMessage', payload: msg });
    });
    injected += batch.length;
    console.log(`Injected ${injected}/${messages.length} messages...`);

    if (injected < messages.length) {
      requestAnimationFrame(injectBatch);
    } else {
      console.log('✅ Done! 200 messages injected. Scroll the chat to test performance.');
    }
  }

  injectBatch();
})();
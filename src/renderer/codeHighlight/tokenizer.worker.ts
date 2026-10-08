import { CodeTokenizer, type HighlightRequest } from './tokenizer';
const tokenizer = new CodeTokenizer();
self.onmessage = (event: MessageEvent<HighlightRequest>) => {
  void tokenizer.highlight(event.data).then(result => self.postMessage(result));
};

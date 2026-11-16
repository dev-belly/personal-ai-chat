export const initialChatState = { messages: [], activeId: null };

// Stale chunks, completions and errors cannot modify a new or cleared session.
export function chatReducer(state, action) {
  if (action.type === 'clear') return initialChatState;
  if (action.type === 'begin') {
    if (state.activeId !== null) return state;
    return {
      activeId: action.id,
      messages: [
        ...state.messages,
        { role: 'user', content: action.text, status: 'pending', request: action.id },
      ],
    };
  }
  if (state.activeId !== action.id) return state;
  if (action.type === 'delta' || action.type === 'complete') {
    const complete = action.type === 'complete';
    const assistant = {
      role: 'assistant',
      content: action.content,
      status: complete ? 'sent' : 'streaming',
      request: action.id,
    };
    const hasAssistant = state.messages.some(
      (message) => message.request === action.id && message.role === 'assistant',
    );
    const messages = state.messages.map((message) => {
      if (message.request !== action.id) return message;
      if (message.role === 'assistant') return assistant;
      return complete ? { ...message, status: 'sent' } : message;
    });
    return {
      activeId: complete ? null : state.activeId,
      messages: hasAssistant ? messages : [...messages, assistant],
    };
  }
  if (action.type === 'fail') {
    return {
      activeId: null,
      messages: [
        ...state.messages.map((message) =>
          message.request === action.id
            ? { ...message, status: message.role === 'assistant' ? 'incomplete' : 'failed' }
            : message,
        ),
        {
          role: 'error',
          content: action.error,
          retryText: action.text,
          requestId: action.requestId,
        },
      ],
    };
  }
  return state;
}

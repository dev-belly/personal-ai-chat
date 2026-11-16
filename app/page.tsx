import ChatApp from './components/chat-app';

// The route stays a Server Component; browser storage and the interactive
// conversation live in the explicit client boundary below.
export default function Home() {
  return <ChatApp />;
}

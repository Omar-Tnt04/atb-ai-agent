import ChatWidget from './components/ChatWidget.jsx';

function App({ isEmbedded = false }) {
  if (isEmbedded) {
    return <ChatWidget />;
  }

  return (
    <main className="widget-preview" aria-label={'Aper\u00e7u du widget Assistant ATB'}>
      <ChatWidget />
    </main>
  );
}

export default App;

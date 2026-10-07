export function createReplayLibraryLoader({ document, source, getLibrary }) {
  let pending;
  return () => {
    if (getLibrary()) return Promise.resolve(getLibrary());
    if (!pending)
      pending = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = source;
        script.onload = () => {
          if (getLibrary()) resolve(getLibrary());
          else {
            pending = undefined;
            script.remove();
            reject(new Error("Replay player could not load"));
          }
        };
        script.onerror = () => {
          pending = undefined;
          script.remove();
          reject(new Error("Replay player could not load"));
        };
        document.head.append(script);
      });
    return pending;
  };
}

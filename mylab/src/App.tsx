import SequenceLabeler from "./SequenceLabeler/SequenceLabeler";

export default function App() {
  return (
    <div style={{height:"100vh"}}>
      <SequenceLabeler
        framesBaseUrl="/dataset/frames"
        indexUrl="/dataset/index.json"
        initialLabelSetName="Default"
        defaultClasses={["Person","Car","Button","Enemy"]}
        prefetchRadius={8}
      />
    </div>
  );
}
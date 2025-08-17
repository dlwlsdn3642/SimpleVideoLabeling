import React, { useRef, useState } from "react";
import SequenceLabeler from "./SequenceLabeler/SequenceLabeler";
import ProjectManager from "./lib/ProjectManager";
import type { Project, Task } from "./types";

export default function App() {
  const pm = useRef(new ProjectManager());
  const [projects, setProjects] = useState<Project[]>(pm.current.getProjects());
  const [currentProject, setCurrentProject] = useState<Project | null>(projects[0] ?? null);
  const [currentTask, setCurrentTask] = useState<Task | null>(currentProject?.tasks[0] ?? null);
  const [panelOpen, setPanelOpen] = useState(true);

  const refresh = () => setProjects([...pm.current.getProjects()]);

  const handleCreateProject = () => {
    const name = prompt("Project name?");
    if (name) {
      const p = pm.current.createProject(name);
      refresh();
      setCurrentProject(p);
      setCurrentTask(null);
    }
  };

  const handleCreateTask = () => {
    if (!currentProject) return;
    const name = prompt("Task name?");
    if (!name) return;
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "true");
    input.onchange = () => {
      const files = input.files;
      if (!files || !files.length) return;
      const file = files[0] as File & { path?: string; webkitRelativePath?: string };
      const fullPath = file.path ?? file.webkitRelativePath ?? "";
      const folder = fullPath.split(/[/\\]/).slice(0, -1).join("/");
      if (folder) {
        const t = pm.current.addTask(currentProject.id, name, folder);
        refresh();
        setCurrentTask(t);
      }
    };
    input.click();
  };

  const selectProject = (id: string) => {
    const p = pm.current.getProjects().find(p => p.id === id) ?? null;
    setCurrentProject(p);
    setCurrentTask(null);
  };

  const selectTask = (t: Task) => setCurrentTask(t);

  return (
    <div style={{ height: "100vh", display: "flex", position: "relative" }}>
      {panelOpen && (
        <div style={{ width: 250, borderRight: "1px solid #ccc", padding: 8, overflowY: "auto" }}>
          <button onClick={handleCreateProject}>New Project</button>
          <ul>
            {projects.map(p => (
              <li key={p.id}>
                <button onClick={() => selectProject(p.id)} style={{ fontWeight: p.id === currentProject?.id ? "bold" : "normal" }}>{p.name}</button>
              </li>
            ))}
          </ul>
          {currentProject && (
            <div>
              <h4>Tasks</h4>
              <button onClick={handleCreateTask}>New Task</button>
              <ul>
                {currentProject.tasks.map(t => (
                  <li key={t.id}>
                    <button onClick={() => selectTask(t)} style={{ fontWeight: t.id === currentTask?.id ? "bold" : "normal" }}>{t.name}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div style={{ flex: 1 }}>
        {currentTask ? (
          <SequenceLabeler
            framesBaseUrl={`${currentTask.workFolder}/frames`}
            indexUrl={`${currentTask.workFolder}/index.json`}
            taskId={currentTask.id}
            initialLabelSetName="Default"
            defaultClasses={["Person", "Car", "Button", "Enemy"]}
            prefetchRadius={8}
          />
        ) : (
          <div style={{ padding: 16 }}>Select a task.</div>
        )}
      </div>
      <button
        onClick={() => setPanelOpen(o => !o)}
        style={{ position: "absolute", top: 8, left: panelOpen ? 258 : 8 }}
      >
        {panelOpen ? "⮜" : "⮞"}
      </button>
    </div>
  );
}

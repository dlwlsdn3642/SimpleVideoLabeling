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
      if (!file.path) return;
      const relPath = file.webkitRelativePath ?? "";
      const folder = file.path
        .slice(0, file.path.length - relPath.length)
        .replace(/\\/g, "/")
        .replace(/\/$/, "");
      const t = pm.current.addTask(currentProject.id, name, folder);
      refresh();
      setCurrentTask(t);
    };
    input.click();
  };

  const selectProject = (id: string) => {
    const p = pm.current.getProjects().find(p => p.id === id) ?? null;
    setCurrentProject(p);
    setCurrentTask(null);
  };

  const selectTask = (t: Task) => setCurrentTask(t);

  const handleDeleteProject = (id: string) => {
    pm.current.deleteProject(id);
    refresh();
    if (currentProject?.id === id) {
      const remaining = pm.current.getProjects();
      const p = remaining[0] ?? null;
      setCurrentProject(p);
      setCurrentTask(p?.tasks[0] ?? null);
    }
  };

  const handleDeleteTask = (projectId: string, taskId: string) => {
    pm.current.deleteTask(projectId, taskId);
    refresh();
    if (currentTask?.id === taskId) {
      setCurrentTask(null);
    }
  };

  return (
    <div style={{ height: "100vh", display: "flex" }}>
      <div
        style={{
          width: panelOpen ? 250 : 32,
          borderRight: "1px solid #ccc",
          padding: 8,
          overflowY: panelOpen ? "auto" : "hidden",
          overflowX: "hidden",
          position: "relative"
        }}
      >
        <button
          onClick={() => setPanelOpen(o => !o)}
          style={{ position: "absolute", top: 8, right: 8 }}
        >
          {panelOpen ? "⮜" : "⮞"}
        </button>
        {panelOpen && (
          <>
            <button onClick={handleCreateProject}>New Project</button>
            <ul>
              {projects.map(p => (
                <li key={p.id}>
                  <button
                    onClick={() => selectProject(p.id)}
                    style={{ fontWeight: p.id === currentProject?.id ? "bold" : "normal" }}
                  >
                    {p.name}
                  </button>
                  <button onClick={() => handleDeleteProject(p.id)} style={{ marginLeft: 4 }}>✕</button>
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
                      <button
                        onClick={() => selectTask(t)}
                        style={{ fontWeight: t.id === currentTask?.id ? "bold" : "normal" }}
                      >
                        {t.name}
                      </button>
                        <button
                          onClick={() => handleDeleteTask(currentProject.id, t.id)}
                          style={{ marginLeft: 4 }}
                        >
                          ✕
                        </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
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
    </div>
  );
}

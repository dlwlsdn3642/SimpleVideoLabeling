import React, { useRef, useState } from "react";
import SequenceLabeler from "./SequenceLabeler";
import ProjectManager from "./lib/ProjectManager";
import type { Project, Task } from "./types";
import { saveDirHandle } from "./utils/handles";
import appStyles from "./App.module.css";
import { ErrorBoundary } from "./components";

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

  const handleCreateTask = async () => {
    if (!currentProject) return;
    const name = prompt("Task name?");
    if (!name) return;
    if ("showDirectoryPicker" in window) {
      try {
        const dir: FileSystemDirectoryHandle = await (window as unknown as {
          showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
        }).showDirectoryPicker();
        const t = pm.current.addTask(currentProject.id, name, dir.name, true);
        await saveDirHandle(t.id, dir);
        refresh();
        setCurrentTask(t);
        return;
      } catch {
        // fall through to input method
      }
    }
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "true");
    input.onchange = () => {
      const files = input.files;
      if (!files || !files.length) return;
      const file = files[0] as File & { path?: string; webkitRelativePath?: string };
      const relPath = file.webkitRelativePath ?? "";
      const fullPath = file.path ?? "";
      let folder = "";
      if (fullPath) {
        folder = fullPath.slice(0, fullPath.length - relPath.length)
          .replace(/\\/g, "/")
          .replace(/\/$/, "");
      } else {
        folder = relPath.split("/")[0] ?? "";
      }
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

  const handleCloseProject = () => {
    setCurrentProject(null);
    setCurrentTask(null);
  };

  return (
    <div className={appStyles.appRoot}>
        <div
          className={appStyles.sidebar}
          style={{ width: panelOpen ? 250 : 0, borderRight: panelOpen ? undefined : "none", padding: panelOpen ? 8 : 0 }}
        >
        {panelOpen && (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button onClick={handleCreateProject}>New Project</button>
              <button onClick={handleCloseProject} disabled={!currentProject}>Close Project</button>
            </div>
            <ul className={appStyles.list}>
              {projects.map(p => (
                <li key={p.id} className={appStyles.listItem}>
                  <button onClick={() => selectProject(p.id)} style={{ fontWeight: p.id === currentProject?.id ? "bold" : "normal", flex: 1, textAlign: "left" }}>
                    {p.name}
                  </button>
                  <button onClick={() => handleDeleteProject(p.id)} title="Delete project">✕</button>
                </li>
              ))}
            </ul>
            {currentProject && (
              <div style={{ marginTop: 8 }}>
                <h4>Tasks</h4>
                <button onClick={handleCreateTask}>New Task</button>
                <ul className={appStyles.list}>
                  {currentProject.tasks.map(t => (
                    <li key={t.id} className={appStyles.listItem}>
                      <button onClick={() => selectTask(t)} style={{ fontWeight: t.id === currentTask?.id ? "bold" : "normal", flex: 1, textAlign: "left" }}>
                        {t.name}
                      </button>
                      <button onClick={() => handleDeleteTask(currentProject.id, t.id)} title="Delete task">✕</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        </div>
        <div className={appStyles.content}>
          {currentTask ? (
            <ErrorBoundary>
            <SequenceLabeler
              framesBaseUrl={`${currentTask.workFolder}/frames`}
              indexUrl={`${currentTask.workFolder}/index.json`}
              taskId={currentTask.id}
              initialLabelSetName="Default"
              defaultClasses={["Person", "Car", "Button", "Enemy"]}
              prefetchRadius={8}
              leftTopExtra={
                <button
                  onClick={() => setPanelOpen(v => !v)}
                  title={panelOpen ? "Hide project panel" : "Show project panel"}
                >
                  {panelOpen ? "⮜" : "⮞"}
                </button>
              }
              onFolderImported={folder => {
                pm.current.updateTaskFolder(currentTask.id, folder, true);
                refresh();
              }}
            />
            </ErrorBoundary>
          ) : (
            <div style={{ padding: 16 }}>Select a task.</div>
          )}
        </div>
    </div>
  );
}

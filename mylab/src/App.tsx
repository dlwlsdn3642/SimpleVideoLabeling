import React, { useRef, useState } from "react";
import SequenceLabeler from "./SequenceLabeler";
import ProjectManager from "./lib/ProjectManager";
import type { Project, Task } from "./types";
import { saveDirHandle } from "./utils/handles";

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

  const handleOpenProject = () => {
    const list = pm.current.getProjects();
    if (!list.length) {
      alert("No projects. Create one first.");
      return;
    }
    if (list.length === 1) {
      setCurrentProject(list[0]);
      setCurrentTask(null);
      return;
    }
    const choice = prompt(
      `Open which project?\n` +
        list.map((p, i) => `${i + 1}. ${p.name}`).join("\n") +
        `\nEnter number:`,
      "1",
    );
    if (!choice) return;
    const idx = parseInt(choice, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= list.length) return;
    setCurrentProject(list[idx]);
    setCurrentTask(null);
  };

  const handleCloseProject = () => {
    setCurrentProject(null);
    setCurrentTask(null);
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateRows: "auto 1fr",
        position: "relative",
      }}
    >
      {/* Top header: move panel toggle here to avoid overlap with timeline */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          borderBottom: "1px solid #ccc",
          background: "#0b0b0b",
        }}
      >
        <button onClick={() => setPanelOpen((v) => !v)} title={panelOpen ? "Hide project panel" : "Show project panel"}>
          {panelOpen ? "⮜" : "⮞"}
        </button>
      </div>

      <div style={{ display: "flex", minHeight: 0 }}>
        <div
          style={{
            width: panelOpen ? 250 : 0,
            borderRight: panelOpen ? "1px solid #ccc" : "none",
            padding: panelOpen ? 8 : 0,
            overflowY: panelOpen ? "auto" : "hidden",
            overflowX: "hidden",
            position: "relative",
            transition: "width 0.2s"
          }}
        >
        {panelOpen && (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button onClick={handleCreateProject}>New Project</button>
              <button onClick={handleOpenProject}>Open Project</button>
              <button onClick={handleCloseProject} disabled={!currentProject}>Close Project</button>
            </div>
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
        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          {currentTask ? (
            <SequenceLabeler
              framesBaseUrl={`${currentTask.workFolder}/frames`}
              indexUrl={`${currentTask.workFolder}/index.json`}
              taskId={currentTask.id}
            initialLabelSetName="Default"
            defaultClasses={["Person", "Car", "Button", "Enemy"]}
            prefetchRadius={8}
            onFolderImported={folder => {
              pm.current.updateTaskFolder(currentTask.id, folder, true);
              refresh();
            }}
          />
        ) : (
          <div style={{ padding: 16 }}>Select a task.</div>
        )}
        </div>
      </div>
    </div>
  );
}

import { Project, Task } from "../types";
import { uuid } from "../utils/geom";

const STORAGE_KEY = "projects_v1";

export default class ProjectManager {
  private projects: Project[] = [];

  constructor() {
    this.load();
  }

  private load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        this.projects = JSON.parse(raw);
      } catch {
        this.projects = [];
      }
    }
  }

  private save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.projects));
  }

  getProjects(): Project[] {
    return this.projects;
  }

  createProject(name: string): Project {
    const project: Project = { id: uuid(), name, tasks: [] };
    this.projects.push(project);
    this.save();
    return project;
    }

  addTask(projectId: string, name: string, workFolder: string): Task {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) throw new Error("Project not found");
    const task: Task = { id: uuid(), name, workFolder };
    project.tasks.push(task);
    this.save();
    return task;
  }

  deleteProject(projectId: string) {
    this.projects = this.projects.filter(p => p.id !== projectId);
    this.save();
  }

  deleteTask(projectId: string, taskId: string) {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return;
    project.tasks = project.tasks.filter(t => t.id !== taskId);
    this.save();
  }

  updateTaskFolder(taskId: string, folder: string) {
    for (const p of this.projects) {
      const t = p.tasks.find(t => t.id === taskId);
      if (t) {
        t.workFolder = folder;
        this.save();
        return;
      }
    }
  }

  getTask(taskId: string): Task | undefined {
    for (const p of this.projects) {
      const t = p.tasks.find(t => t.id === taskId);
      if (t) return t;
    }
    return undefined;
  }
}

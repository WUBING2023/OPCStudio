import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const USER_DATA_DIR = path.join(os.homedir(), ".opcstudio");

export function getUserDataDir(): string {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  return USER_DATA_DIR;
}

export function getSkillsDir(): string {
  // OPC_SKILLS_DIR 覆盖默认用户目录:测试用它把技能写进临时区(不污染 ~/.opcstudio/skills);也允许
  // 部署自定义技能库位置。生产无此 env → 行为不变(每次调用读 env,不缓存)。
  const dir = process.env.OPC_SKILLS_DIR || path.join(USER_DATA_DIR, "skills");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

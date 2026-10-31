/**
 * 进程环境初始化：必须作为入口文件的第一个 import。
 *
 * ESM 的 import 会在模块体求值前按声明顺序执行，所以只要把它放在第一行，
 * dotenv 就会先于任何业务模块读取 process.env —— 否则 app/db 等模块在
 * loadEnv() 之前就已求值，.env 里的 TZ、DB_PATH 等配置不会生效。
 */
import { config } from 'dotenv';

config();

// 时区兜底：截单时间、歇菜月份、季节菜、自动备份日期与 SQLite 的
// datetime('now','localtime') 都按进程本地时间算。.env / 容器未设置 TZ 时，
// UTC 会把「今晚的饭」整体挪 8 小时；显式配置了 TZ 则尊重配置。
if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai';

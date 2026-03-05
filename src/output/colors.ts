import { Chalk } from "chalk";

const chalk = new Chalk();

const number = chalk.green;
const path = chalk.blue;
const keyword = chalk.cyan;

const debug = chalk.gray;
const info = chalk.white;
const success = chalk.green;
const warning = chalk.yellow;
const error = chalk.red;

const defaultExport = { debug, error, info, keyword, number, path, success, warning };

// oxlint-disable-next-line import/no-default-export
export default defaultExport;

import { Chalk } from "chalk";

const chalk = new Chalk();

const number = chalk.green;
const path = chalk.blue;
const keyword = chalk.cyan;

const debug = chalk.gray;
const info = chalk.white;
const warning = chalk.yellow;
const error = chalk.red;

const defaultExport = { debug, error, info, keyword, number, path, warning };

// oxlint-disable-next-line import/no-default-export
export default defaultExport;

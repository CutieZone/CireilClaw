import { Chalk } from "chalk";

const chalk = new Chalk();

const number = chalk.green;
const path = chalk.blue;
const keyword = chalk.yellow;

const defaultExport = { keyword, number, path };

// oxlint-disable-next-line import/no-default-export
export default defaultExport;

import {createDispatcher} from "./dispatcher";
import {postgresJobRepository} from "./postgresJobRepository";
export const durableJobRepository=postgresJobRepository;
export const durableJobDispatcher=createDispatcher(postgresJobRepository);


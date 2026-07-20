import {createAiGateway} from "./gateway";import {DeterministicMockProvider} from "./mockProvider";import {postgresAiGatewayRepository} from "./postgresRepository";
export const aiGatewayRepository=postgresAiGatewayRepository;export const aiGateway=createAiGateway(postgresAiGatewayRepository,new DeterministicMockProvider());

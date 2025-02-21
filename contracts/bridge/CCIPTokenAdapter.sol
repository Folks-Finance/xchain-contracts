// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./CCIPAdapter.sol";
import "./libraries/Messages.sol";
import "./libraries/CCIPTokenMessages.sol";

contract CCIPTokenAdapter is CCIPAdapter {
    using SafeERC20 for IERC20;

    error InvalidDestTokenAmountsLength();
    error TokenAlreadySupported(address token);
    error TokenNotSupported(address token);
    error ReceivedTokenMissmatch(address token);

    mapping(address token => bool isSupported) private supportedTokens;

    /**
     * @notice Constructor
     * @param admin The default admin for AccountManager
     * @param ccipRouter The CCIP router to relay messages using
     * @param bridgeRouter The Bridge Router to route messages through
     */
    constructor(
        address admin,
        IRouterClient ccipRouter,
        IBridgeRouter bridgeRouter
    ) CCIPAdapter(admin, ccipRouter, bridgeRouter) {}

    function addSupportedToken(address token) external onlyRole(MANAGER_ROLE) {
        if (isTokenSupported(token)) revert TokenAlreadySupported(token);

        // add token
        supportedTokens[token] = true;
    }

    function removeSupportedToken(address token) external onlyRole(MANAGER_ROLE) {
        if (!isTokenSupported(token)) revert TokenNotSupported(token);

        // remove token
        delete supportedTokens[token];
    }

    function sendMessage(Messages.MessageToSend calldata message) external payable override onlyBridgeRouter {
        // get chain adapter if available
        (uint64 ccipChainId, bytes32 adapterAddress) = getChainAdapter(message.destinationChainId);

        // must be finalised message
        // ensure receiver value is zero and extra args is not empty
        if (message.finalityLevel == 0) revert InvalidFinalityLevel(message.finalityLevel);
        if (message.params.receiverValue > 0) revert UnsupportedReceiverValue();
        if (message.extraArgs.length == 0) revert EmptyExtraArgs();

        // check extra args format and read
        Messages.ExtraArgsV1 memory extraArgs = Messages.bytesToExtraArgs(message.extraArgs);
        address token = Messages.convertGenericAddressToEVMAddress(extraArgs.token);
        if (!isTokenSupported(token)) revert InvalidTokenAddress(extraArgs.token);

        IERC20(token).approve(address(ccipRouter), extraArgs.amount);

        // send using ccip router
        Client.EVM2AnyMessage memory ccipMessage = _buildCCIPMessage(adapterAddress, message);
        bytes32 messageId = ccipRouter.ccipSend{ value: msg.value }(ccipChainId, ccipMessage);

        emit SendMessage(messageId, message);
    }

    function isTokenSupported(address token) public view returns (bool) {
        return supportedTokens[token];
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        (CCIPTokenMessages.CCIPTokenMetadata memory ccipTokenMetadata, bytes memory messagePayload) = CCIPTokenMessages
            .decodePayloadWithCCIPTokenMetadata(message.data);

        // check source chain and source address
        uint16 folksChainId = ccipChainIdToFolksChainId[message.sourceChainSelector];
        bytes32 sourceAddress = Messages.convertEVMAddressToGenericAddress(abi.decode(message.sender, (address)));
        (uint64 ccipChainId, bytes32 adapterAddress) = getChainAdapter(folksChainId);
        if (message.sourceChainSelector != ccipChainId) revert ChainUnavailable(folksChainId);
        if (adapterAddress != sourceAddress) revert InvalidMessageSender(sourceAddress);

        // ensure the CCIP message has been paired with correct Token transfer
        if (message.destTokenAmounts.length != 1) revert InvalidDestTokenAmountsLength();
        address token = message.destTokenAmounts[0].token;
        uint256 receivedAmount = message.destTokenAmounts[0].amount;
        if (!isTokenSupported(token)) revert InvalidTokenAddress(Messages.convertEVMAddressToGenericAddress(token));
        if (ccipTokenMetadata.amount != receivedAmount)
            revert InvalidReceivedAmount(ccipTokenMetadata.amount, receivedAmount);

        // forward token to intended recipient
        address recipient = Messages.convertGenericAddressToEVMAddress(ccipTokenMetadata.recipient);
        IERC20(token).safeTransfer(recipient, receivedAmount);

        // construct and forward message to bridge router
        Messages.MessageReceived memory messageReceived = Messages.MessageReceived({
            messageId: message.messageId,
            sourceChainId: folksChainId,
            sourceAddress: ccipTokenMetadata.messageMetadata.sender,
            handler: ccipTokenMetadata.messageMetadata.handler,
            payload: messagePayload,
            returnAdapterId: ccipTokenMetadata.messageMetadata.returnAdapterId,
            returnGasLimit: ccipTokenMetadata.messageMetadata.returnGasLimit
        });
        bridgeRouter.receiveMessage(messageReceived);

        emit ReceiveMessage(messageReceived.messageId);
    }

    /// @notice Construct a CCIP message.
    /// @dev This function will create an EVM2AnyMessage struct with all the necessary information for sending a text.
    /// @return Client.EVM2AnyMessage Returns an EVM2AnyMessage struct which contains information for sending a CCIP message.
    function _buildCCIPMessage(
        bytes32 adapterAddress,
        Messages.MessageToSend calldata message
    ) internal pure override returns (Client.EVM2AnyMessage memory) {
        // prepare target address and payload
        address targetAddress = Messages.convertGenericAddressToEVMAddress(adapterAddress);

        Messages.ExtraArgsV1 memory extraArgs = Messages.bytesToExtraArgs(message.extraArgs);
        bytes memory payloadWithMetadata = CCIPTokenMessages.encodePayloadWithCCIPTokenMetadata(
            extraArgs.amount,
            extraArgs.token,
            extraArgs.recipient,
            message
        );

        // set the token amounts
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](1);
        tokenAmounts[0] = Client.EVMTokenAmount({
            token: Messages.convertGenericAddressToEVMAddress(extraArgs.token),
            amount: extraArgs.amount
        });

        // Create an EVM2AnyMessage struct in memory with necessary information for sending a cross-chain message
        return
            Client.EVM2AnyMessage({
                receiver: abi.encode(targetAddress),
                data: payloadWithMetadata,
                tokenAmounts: tokenAmounts,
                feeToken: address(0),
                extraArgs: Client._argsToBytes(Client.EVMExtraArgsV1({ gasLimit: message.params.gasLimit }))
            });
    }
}

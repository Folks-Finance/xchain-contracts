// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import "@wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "@wormhole-solidity-sdk/interfaces/IWormholeReceiver.sol";
import "@wormhole-solidity-sdk/interfaces/IWormholeRelayer.sol";

import "./interfaces/IBridgeAdapter.sol";
import "./interfaces/IBridgeRouter.sol";
import "./libraries/Messages.sol";
import "./libraries/Wormhole.sol";

contract WormholeDataAdapter is IBridgeAdapter, IWormholeReceiver, AccessControlDefaultAdminRules {
    bytes32 public constant override MANAGER_ROLE = keccak256("MANAGER");

    event ReceiveMessage(bytes32 indexed messageId, bytes32 adapterAddress);

    error InvalidWormholeRelayer(address sender);

    struct WormholeAdapterParams {
        bool isAvailable;
        uint16 wormholeChainId;
        bytes32 adapterAddress;
    }

    mapping(uint16 folksChainId => WormholeAdapterParams) internal folksChainIdToWormholeAdapter;
    mapping(uint16 wormholeChainId => uint16 folksChainId) internal wormholeChainIdToFolksChainId;

    IWormhole public immutable wormhole;
    IWormholeRelayer public immutable wormholeRelayer;
    IBridgeRouter public immutable bridgeRouter;
    address public refundAddress;

    modifier onlyBridgeRouter() {
        if (msg.sender != address(bridgeRouter)) revert InvalidBridgeRouter(msg.sender);
        _;
    }

    modifier onlyWormholeRelayer() {
        if (msg.sender != address(wormholeRelayer)) revert InvalidWormholeRelayer(msg.sender);
        _;
    }

    /**
     * @notice Constructor
     * @param admin The default admin for AccountManager
     * @param _wormhole The Wormhole Core to get message fees
     * @param _wormholeRelayer The Wormhole Relayer to relay messages using
     * @param _bridgeRouter The Bridge Router to route messages through
     * @param _refundAddress The address to deliver any refund to
     */
    constructor(
        address admin,
        IWormhole _wormhole,
        IWormholeRelayer _wormholeRelayer,
        IBridgeRouter _bridgeRouter,
        address _refundAddress
    ) AccessControlDefaultAdminRules(1 days, admin) {
        wormhole = _wormhole;
        wormholeRelayer = _wormholeRelayer;
        bridgeRouter = _bridgeRouter;
        refundAddress = _refundAddress;
        _grantRole(MANAGER_ROLE, admin);
    }

    function getSendFee(Messages.MessageToSend memory message) external view override returns (uint256 fee) {
        // get chain adapter if available
        (uint16 wormholeChainId, ) = getChainAdapter(message.destinationChainId);

        // get cost of message delivery
        uint256 deliveryCost;
        (deliveryCost, ) = wormholeRelayer.quoteEVMDeliveryPrice(
            wormholeChainId,
            message.params.receiverValue,
            message.params.gasLimit
        );

        // add cost of publishing message
        fee = deliveryCost + wormhole.messageFee();
    }

    function sendMessage(Messages.MessageToSend memory message) external payable override onlyBridgeRouter {
        // get chain adapter if available
        (uint16 wormholeChainId, bytes32 adapterAddress) = getChainAdapter(message.destinationChainId);

        // ensure extra args is empty
        if (message.extraArgs.length > 0) revert UnsupportedExtraArgs();

        // prepare payload by adding metadata
        bytes memory payloadWithMetadata = Messages.encodePayloadWithMetadata(message);

        // send using wormhole relayer
        uint8 consistencyLevel = Wormhole.getConsistencyLevel(message.finalityLevel);
        uint64 sequence = wormholeRelayer.sendToEvm{ value: msg.value }(
            wormholeChainId,
            Messages.convertGenericAddressToEVMAddress(adapterAddress),
            payloadWithMetadata,
            message.params.receiverValue,
            0,
            message.params.gasLimit,
            wormholeChainId,
            refundAddress,
            wormholeRelayer.getDefaultDeliveryProvider(),
            new VaaKey[](0),
            consistencyLevel
        );

        emit SendMessage(bytes32(uint256(sequence)), message);
    }

    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory, // additionalVaas
        bytes32 sourceAddress, // address that called 'sendPayloadToEvm'
        uint16 sourceChain,
        bytes32 deliveryHash // unique identifier of delivery
    ) external payable override onlyWormholeRelayer {
        // check source chain and source address
        uint16 folksChainId = wormholeChainIdToFolksChainId[sourceChain];
        (uint16 wormholeChainId, bytes32 adapterAddress) = getChainAdapter(folksChainId);
        if (sourceChain != wormholeChainId) revert ChainUnavailable(folksChainId);
        if (adapterAddress != sourceAddress) revert InvalidMessageSender(sourceAddress);

        // decode into metadata and message payload
        (Messages.MessageMetadata memory metadata, bytes memory messagePayload) = Messages.decodePayloadWithMetadata(
            payload
        );

        // construct and forward message to bridge router
        Messages.MessageReceived memory messageReceived = Messages.MessageReceived({
            messageId: deliveryHash,
            sourceChainId: folksChainId,
            sourceAddress: metadata.sender,
            handler: metadata.handler,
            payload: messagePayload,
            returnAdapterId: metadata.returnAdapterId,
            returnGasLimit: metadata.returnGasLimit
        });
        bridgeRouter.receiveMessage{ value: msg.value }(messageReceived);

        emit ReceiveMessage(messageReceived.messageId, adapterAddress);
    }

    function setRefundAddress(address _refundAddress) external onlyRole(MANAGER_ROLE) {
        refundAddress = _refundAddress;
    }

    function addChain(
        uint16 folksChainId,
        uint16 wormholeChainId,
        bytes32 adapterAddress
    ) external onlyRole(MANAGER_ROLE) {
        // check if chain is already added
        bool isAvailable = isChainAvailable(folksChainId);
        if (isAvailable) revert ChainAlreadyAdded(folksChainId);

        // add chain
        folksChainIdToWormholeAdapter[folksChainId] = WormholeAdapterParams({
            isAvailable: true,
            wormholeChainId: wormholeChainId,
            adapterAddress: adapterAddress
        });
        wormholeChainIdToFolksChainId[wormholeChainId] = folksChainId;
    }

    function removeChain(uint16 folksChainId) external onlyRole(MANAGER_ROLE) {
        // get chain adapter if available
        (uint16 wormholeChainId, ) = getChainAdapter(folksChainId);

        // remove chain
        delete folksChainIdToWormholeAdapter[folksChainId];
        delete wormholeChainIdToFolksChainId[wormholeChainId];
    }

    function isChainAvailable(uint16 chainId) public view override returns (bool) {
        return folksChainIdToWormholeAdapter[chainId].isAvailable;
    }

    function getChainAdapter(uint16 chainId) public view returns (uint16 wormholeChainId, bytes32 adapterAddress) {
        WormholeAdapterParams memory chainAdapter = folksChainIdToWormholeAdapter[chainId];
        if (!chainAdapter.isAvailable) revert ChainUnavailable(chainId);

        wormholeChainId = chainAdapter.wormholeChainId;
        adapterAddress = chainAdapter.adapterAddress;
    }
}
